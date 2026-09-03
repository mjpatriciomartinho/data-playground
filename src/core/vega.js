// Translate a chart spec plus a query result into Vega-Lite.
//
// The agent never writes Vega-Lite. It writes intent (mark, measure, dimension,
// grain) and the page turns that into a correct chart, with the right axis
// titles, number formats and colour treatment for the measure involved.

import { detectGeo, geoKey, TOPO } from './geo.js';
import { derive, DEFAULT_THEME } from './theme.js';

// The charts read the same palette the interface does, so a themed board is
// themed all the way through rather than only around the edges.
let palette = derive(DEFAULT_THEME);

export function setChartTheme(theme) {
  palette = derive(theme);
  return palette;
}

const FORMAT = {
  currency: { axis: '$,.0f', tooltip: '$,.2f' },
  percent: { axis: '.0%', tooltip: '.2%' },
  number: { axis: ',.0f', tooltip: ',.2f' },
};

export function toVegaLite(model, chart, result, { dark = palette.dark } = {}) {
  const { spec } = chart;
  const PALETTE = palette.series;
  const dimField = spec.groupBy?.[0]?.field;
  const seriesField = spec.groupBy?.[1]?.field;
  const metricAlias = result.columns[result.columns.length - 1];
  const measureName = spec.metrics[0].field;
  const measure = model.field(measureName);
  const fmt = FORMAT[measure?.format ?? 'number'] ?? FORMAT.number;

  const muted = palette.inkFaint;
  const grid = palette.rule;

  const dimType = (() => {
    const f = model.field(dimField);
    if (!f) return 'nominal';
    if (f.role === 'time') return 'ordinal';
    return 'nominal';
  })();

  const values = result.rows.map((r) => {
    const rec = { [metricAlias]: r[metricAlias], __rows: r.__rowCount };
    if (dimField) rec[dimField] = r[dimField];
    if (seriesField) rec[seriesField] = r[seriesField];
    return rec;
  });

  const base = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    data: { values },
    width: 'container',
    height: 240,
    background: 'transparent',
    config: {
      font: palette.chartFont ?? 'ui-sans-serif, system-ui, sans-serif',
      axis: { labelColor: muted, titleColor: muted, gridColor: grid, domainColor: grid, tickColor: grid, labelFontSize: 11, titleFontSize: 11 },
      legend: { labelColor: muted, titleColor: muted, labelFontSize: 11, titleFontSize: 11 },
      view: { stroke: null },
      range: { category: PALETTE },
    },
  };

  const quantEnc = {
    field: metricAlias,
    type: 'quantitative',
    title: prettyMetric(spec.metrics[0], measureName),
    axis: { format: fmt.axis },
  };

  const tooltip = [
    dimField && { field: dimField, type: dimType, title: dimField },
    seriesField && { field: seriesField, type: 'nominal', title: seriesField },
    { field: metricAlias, type: 'quantitative', title: prettyMetric(spec.metrics[0], measureName), format: fmt.tooltip },
    { field: '__rows', type: 'quantitative', title: 'rows', format: ',.0f' },
  ].filter(Boolean);

  const colour = seriesField
    ? { field: seriesField, type: 'nominal', title: seriesField }
    : spec.mark === 'pie'
    ? { field: dimField, type: dimType, title: dimField }
    : // A single-series bar chart of a signed measure reads far better when
      // losses are a different colour from gains.
      hasNegatives(values, metricAlias)
      ? { condition: { test: `datum['${metricAlias}'] < 0`, value: palette.negative }, value: PALETTE[0] }
      : { value: PALETTE[0] };

  switch (spec.mark) {
    case 'map': {
      // A choropleth needs the map outline and a join key. Both come from the
      // page's own geo detection, so the agent only ever asks for "map".
      const geo = detectGeo(model, dimField);
      if (!geo) {
        return {
          ...base,
          mark: { type: 'text', fontSize: 12, color: muted },
          encoding: { text: { value: `"${dimField}" does not look like a place, so it cannot be mapped.` } },
        };
      }
      const topo = TOPO[geo.kind];
      const joined = values
        .map((v) => ({ ...v, __geo: geoKey(geo.kind, v[dimField]) }))
        .filter((v) => v.__geo != null);

      const diverging = joined.some((v) => (v[metricAlias] ?? 0) < 0);

      const lookupKey = geo.kind === 'us-state' ? 'id' : 'properties.name';
      const emptyLand = palette.rule;
      const border = palette.paperRaised;

      // Two layers. The first draws every state in the atlas in a flat, quiet
      // colour, so the country keeps its shape; the second paints the ones with
      // data on top. Drawing only the states that appear in the data leaves a
      // map full of holes, which reads as a rendering fault rather than an
      // absence of sales.
      return {
        $schema: base.$schema,
        width: 'container',
        height: 300,
        background: 'transparent',
        config: base.config,
        layer: [
          {
            data: { url: topo.url, format: { type: 'topojson', feature: topo.feature } },
            projection: { type: topo.projection },
            mark: { type: 'geoshape', fill: emptyLand, stroke: border, strokeWidth: 0.5 },
          },
          {
            data: { url: topo.url, format: { type: 'topojson', feature: topo.feature } },
            projection: { type: topo.projection },
            transform: [
              {
                lookup: lookupKey,
                from: { data: { values: joined }, key: '__geo', fields: [metricAlias, dimField, '__rows'] },
              },
              // Keep only the shapes the join actually matched.
              { filter: `isValid(datum['${metricAlias}'])` },
            ],
            // Named so a click handler can tell the data layer from the grey
            // outline beneath it: the background layer's datum is empty, and
            // hit-testing returns whichever mark is on top.
            name: 'geo_data',
            mark: { type: 'geoshape', stroke: border, strokeWidth: 0.5 },
            encoding: {
              color: {
                field: metricAlias,
                type: 'quantitative',
                title: prettyMetric(spec.metrics[0], measureName),
                // Losses need their own end of the scale, not a paler shade of gain.
                scale: diverging
                  ? { range: [palette.negative, palette.negativeSoft, palette.accentSoft, palette.accent], domainMid: 0 }
                  : { range: [palette.accentSoft, palette.accent] },
                legend: { format: fmt.axis },
              },
              tooltip: [
                { field: dimField, type: 'nominal', title: dimField },
                { field: metricAlias, type: 'quantitative', title: prettyMetric(spec.metrics[0], measureName), format: fmt.tooltip },
                { field: '__rows', type: 'quantitative', title: 'rows', format: ',.0f' },
              ],
            },
          },
        ],
      };
    }

    case 'pie': {
      // A pie encodes magnitude as area, which silently misrepresents any
      // negative value. Rather than draw a lie, fall back to bars and say so.
      if (hasNegatives(values, metricAlias)) {
        return {
          ...base,
          height: Math.max(180, values.length * 30),
          mark: { type: 'bar', cornerRadiusEnd: 3, tooltip: true },
          encoding: {
            y: { field: dimField, type: dimType, title: dimField, sort: '-x' },
            x: quantEnc,
            color: { condition: { test: `datum['${metricAlias}'] < 0`, value: palette.negative }, value: PALETTE[0] },
            tooltip,
          },
          title: {
            text: 'Shown as bars: a pie cannot represent negative values',
            fontSize: 10,
            color: muted,
            fontWeight: 'normal',
            anchor: 'start',
          },
        };
      }
      return {
        ...base,
        height: 240,
        mark: { type: 'arc', innerRadius: 55, stroke: palette.paperRaised, strokeWidth: 2 },
        encoding: { theta: { field: metricAlias, type: 'quantitative' }, color: colour, tooltip },
      };
    }

    case 'line':
    case 'area':
      return {
        ...base,
        mark: { type: spec.mark, point: spec.mark === 'line' && values.length <= 40, tooltip: true, opacity: spec.mark === 'area' ? 0.75 : 1 },
        encoding: {
          x: {
            field: dimField,
            type: dimType,
            title: dimField,
            // A dense time axis prints every label on top of the last one.
            // Thin them out until they fit, and tilt them when they are long.
            axis: {
              labelAngle: values.length > 8 ? -45 : 0,
              labelOverlap: 'greedy',
              values: axisTicks(values, dimField),
            },
          },
          y: quantEnc,
          color: colour,
          tooltip,
        },
      };

    case 'scatter':
      return {
        ...base,
        mark: { type: 'point', filled: true, size: 70, opacity: 0.8 },
        encoding: {
          x: { field: dimField, type: dimType, title: dimField },
          y: quantEnc,
          color: colour,
          tooltip,
        },
      };

    case 'heatmap':
      return {
        ...base,
        mark: 'rect',
        encoding: {
          x: { field: dimField, type: dimType, title: dimField },
          y: { field: seriesField, type: 'nominal', title: seriesField },
          color: {
            field: metricAlias,
            type: 'quantitative',
            title: prettyMetric(spec.metrics[0], measureName),
            scale: { range: [palette.accentSoft, palette.accent] },
          },
          tooltip,
        },
      };

    case 'bar':
    default: {
      const horizontal = values.length > 7 && dimType === 'nominal';
      const cat = { field: dimField, type: dimType, title: dimField, sort: horizontal ? '-x' : undefined };
      return {
        ...base,
        height: horizontal ? Math.max(180, values.length * 26) : 240,
        mark: { type: 'bar', cornerRadiusEnd: 3, tooltip: true },
        encoding: horizontal
          ? { y: cat, x: quantEnc, color: colour, tooltip }
          : { x: { ...cat, axis: { labelAngle: dimType === 'ordinal' ? 0 : -35 } }, y: quantEnc, color: colour, tooltip },
      };
    }
  }
}

function hasNegatives(values, alias) {
  return values.some((v) => (v[alias] ?? 0) < 0);
}

/**
 * Did a requested pie get drawn as bars instead?
 *
 * The substitution is decided while building the spec, and is announced on the
 * chart itself. But a chart title is not visible to an agent, so the canvas
 * tools call this to put the same correction in the string they return. The
 * agent needs to know it was overruled, otherwise it cheerfully describes a
 * pie chart that is not on screen.
 */
export function pieDowngradedToBars(chart, result) {
  if (chart.mark !== 'pie') return false;
  const alias = result?.columns?.[1];
  if (!alias) return false;
  return hasNegatives(result.rows ?? [], alias);
}

// Keep at most a dozen labels on a categorical time axis, evenly spaced, so the
// reader gets landmarks instead of a smudge.
function axisTicks(values, dimField) {
  if (!dimField || values.length <= 12) return undefined;
  const step = Math.ceil(values.length / 10);
  return values.filter((_, i) => i % step === 0).map((v) => v[dimField]);
}

function prettyMetric(metric, measureName) {
  if (metric.agg === 'count') return 'Rows';
  if (metric.agg === 'ratio') return measureName;
  return `${metric.agg.toUpperCase()} of ${measureName}`;
}
