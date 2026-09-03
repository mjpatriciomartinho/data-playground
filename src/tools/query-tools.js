// WebMCP tools, layer 2: querying and drilling.
//
// The agent never receives rows. It receives grouped aggregates, at most a few
// dozen at a time, computed here in the tab. That is the privacy guarantee, and
// it is architectural rather than a promise.

import { ROLE } from '../core/model.js';
import { detectGeo } from '../core/geo.js';
import { runQuery, formatResult, OPERATORS } from '../core/query.js';

import { registerTool } from '../core/registry.js';

// The schemas below are built from the loaded model rather than declared as
// constants, because the whole point is that they carry this file's real column
// names as enums. An agent reading the schema cannot name a column that does not
// exist: the invalid call is unrepresentable rather than merely rejected.
//
// They are rebuilt on every model change (see ToolRegistry.registerDataTools),
// so a field defined thirty seconds ago by define_calculated_field appears in
// these enums like any other.
//
// `enumOr` guards the degenerate case: JSON Schema treats an empty enum as
// "no value is valid", which would lock the agent out of a tool entirely. A
// dataset with no measures is possible (a CSV of pure categories), so fall back
// to a plain string when there is nothing to enumerate.
const enumOr = (names, description) =>
  names.length ? { type: 'string', enum: names, description } : { type: 'string', description };

const fieldSchemas = (model) => {
  const all = model ? model.fieldNames() : [];
  const measures = model ? model.measures().map((f) => f.name) : [];
  const dimensions = model ? model.dimensions().map((f) => f.name) : [];

  const FILTER_SCHEMA = {
    type: 'array',
    description:
      'Filters to apply on top of the ones the user set by hand. Each is {col, op, value}. ' +
      'For a date field you may filter on a grain key such as "2016" or "2016-Q3", or on an ISO date.',
    items: {
      type: 'object',
      properties: {
        col: enumOr(all, 'Field to filter on'),
        op: { type: 'string', enum: OPERATORS },
        value: { description: 'A value, or an array for "in" / "between"' },
      },
      required: ['col', 'op', 'value'],
    },
  };

  const METRIC_SCHEMA = {
    type: 'array',
    description:
      'Measures to compute. Each is {field, agg}. Use agg "ratio" for measures defined as ratios; ' +
      'the page rejects aggregations that would be statistically wrong and tells you why.',
    items: {
      type: 'object',
      properties: {
        field: enumOr(measures, 'Measure to aggregate'),
        agg: { type: 'string', enum: ['sum', 'avg', 'min', 'max', 'count', 'ratio'] },
      },
      required: ['field', 'agg'],
    },
  };

  const GROUP_SCHEMA = {
    type: 'array',
    description:
      'Dimensions to group by. Each is {field, grain}. "grain" applies only to date fields and is ' +
      'one of year, quarter, month, week, day.',
    items: {
      type: 'object',
      properties: {
        field: enumOr(dimensions, 'Dimension to group by'),
        grain: { type: 'string', enum: ['year', 'quarter', 'month', 'week', 'day'] },
      },
      required: ['field'],
    },
  };

  return { FILTER_SCHEMA, METRIC_SCHEMA, GROUP_SCHEMA, all, measures, dimensions };
};

export { fieldSchemas, enumOr };

export function registerQueryTools(app, signal) {
  // Nothing to register in a browser without WebMCP; the page still works.
  if (!document.modelContext && !navigator.modelContext) return [];

  const { FILTER_SCHEMA, METRIC_SCHEMA, GROUP_SCHEMA, measures, dimensions } = fieldSchemas(app.model);

  const registered = [];
  const add = (def) => {
    registerTool(def, { signal });
    registered.push(def.name);
  };

  add({
    name: 'query_data',
    description:
      'Group, filter and aggregate the dataset, and get the numbers back as a table. Use this to ' +
      'reason about the data before or instead of drawing a chart. The user-set filters shown by ' +
      'describe_dataset are always applied first.',
    inputSchema: {
      type: 'object',
      properties: {
        groupBy: GROUP_SCHEMA,
        metrics: METRIC_SCHEMA,
        filters: FILTER_SCHEMA,
        sort: {
          type: 'object',
          properties: {
            by: { type: 'string', description: 'Column name in the result, e.g. "sum(Sales)"' },
            dir: { type: 'string', enum: ['asc', 'desc'] },
          },
        },
        limit: { type: 'number', description: 'Maximum groups to return (default 25)' },
      },
      required: ['metrics'],
    },
    annotations: { readOnlyHint: true },
    execute: async ({ groupBy, metrics, filters = [], sort, limit = 25 }) => {
      if (!app.model) return 'No dataset loaded.';
      try {
        const result = runQuery(app.model, {
          groupBy,
          metrics,
          filters: [...app.activeFilters(), ...filters],
          sort,
          limit,
        });
        return formatResult(app.model, result);
      } catch (e) {
        return e.isSemanticError ? `Rejected: ${e.message}` : `Query failed: ${e.message}`;
      }
    },
  });

  add({
    name: 'drill_down',
    description:
      'Take an existing chart, narrow it to one of its categories, and re-group it by a finer ' +
      'dimension. This is how you answer "why". Chaining two or three drill_down calls walks from ' +
      'a headline number to the specific rows responsible for it, which by hand would be twenty ' +
      'clicks. If you omit "into", the page picks the dimension that best explains the variation.',
    inputSchema: {
      type: 'object',
      properties: {
        chartId: { type: 'string', description: 'Chart to drill into, from list_charts' },
        value: { type: 'string', description: 'The category to drill into, e.g. "West"' },
        into: enumOr(dimensions, 'Dimension to break it down by. Optional.'),
      },
      required: ['chartId', 'value'],
    },
    execute: async ({ chartId, value, into }) => {
      if (!app.model) return 'No dataset loaded.';
      const chart = app.getChart(chartId);
      if (!chart) return `No chart "${chartId}". Call list_charts to see what exists.`;

      const parentDim = chart.spec.groupBy?.[0]?.field;
      if (!parentDim) return `Chart "${chartId}" is not grouped by anything, so there is nothing to drill into.`;

      // Drilling into a value the parent dimension does not contain produces an
      // empty chart and a confident wrong answer. Catch it and say where the
      // value actually lives.
      const known = app.model.distinctValues(parentDim, 5000).map((v) => v.value);
      if (!known.includes(String(value))) {
        const elsewhere = findFieldContaining(app.model, value, parentDim);
        const near = known.filter((k) => k.toLowerCase().includes(String(value).toLowerCase())).slice(0, 5);
        return [
          `"${value}" is not a value of ${parentDim}, which is what chart "${chartId}" is grouped by.`,
          near.length ? `Close matches in ${parentDim}: ${near.join(', ')}.` : `Values of ${parentDim}: ${known.slice(0, 12).join(', ')}${known.length > 12 ? ', ...' : ''}.`,
          elsewhere
            ? `"${value}" is a value of "${elsewhere}". To drill by it, first create a chart grouped by ${elsewhere}, or call query_data with a filter on ${elsewhere}.`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
      }

      const target = into ?? suggestDrillDimension(app.model, chart, parentDim, value);
      if (!target) return 'Could not find a suitable dimension to drill into. Pass "into" explicitly.';

      const filters = [...(chart.spec.filters ?? []), { col: parentDim, op: '=', value }];
      // The mark has to follow the new grouping: a map of States drilled into
      // Sub-Category is not a map, and a KPI has nothing to group by at all.
      let mark = chart.spec.mark;
      if (mark === 'map' && !detectGeo(app.model, target)) mark = 'bar';
      if (mark === 'kpi' || mark === 'heatmap') mark = 'bar';

      const spec = {
        ...chart.spec,
        mark,
        groupBy: [{ field: target }],
        filters,
        title: `${chart.spec.title ?? 'Chart'}: ${value} by ${target}`,
      };

      const newChart = app.addChart(spec, { drilledFrom: chartId, drillPath: [...(chart.drillPath ?? []), `${parentDim}=${value}`] });
      const result = runQuery(app.model, { ...spec, filters: [...app.activeFilters(), ...filters] });
      return [
        `Drilled into ${parentDim} = "${value}", broken down by ${target}. Chart "${newChart.id}" added to the canvas.`,
        '',
        formatResult(app.model, result, { maxRows: 15 }),
        '',
        `Drill path: ${[...(chart.drillPath ?? []), `${parentDim}=${value}`].join(' > ')}. Call drill_down again on "${newChart.id}" to go deeper.`,
      ].join('\n');
    },
  });

  add({
    name: 'find_outliers',
    description:
      'Find the groups that deviate most from the norm for a measure: the biggest contributors, ' +
      'the biggest losses, and any group more than two standard deviations from the mean. Use it ' +
      'when the user asks what is unusual, what is going wrong, or where to look.',
    inputSchema: {
      type: 'object',
      properties: {
        dimension: enumOr(dimensions, 'Dimension to break the data down by'),
        measure: enumOr(measures, 'Measure to examine'),
        agg: { type: 'string', enum: ['sum', 'avg', 'ratio'], description: 'How to aggregate (default sum)' },
        filters: FILTER_SCHEMA,
      },
      required: ['dimension', 'measure'],
    },
    annotations: { readOnlyHint: true },
    execute: async ({ dimension, measure, agg = 'sum', filters = [] }) => {
      if (!app.model) return 'No dataset loaded.';
      try {
        const field = app.model.field(measure);
        const useAgg = field?.additivity === 'ratio' ? 'ratio' : agg;
        const result = runQuery(app.model, {
          groupBy: [{ field: dimension }],
          metrics: [{ field: measure, agg: useAgg }],
          filters: [...app.activeFilters(), ...filters],
        });
        const alias = result.columns[1];
        const vals = result.rows.map((r) => r[alias]).filter((v) => v != null);
        if (!vals.length) return 'Nothing to analyse.';

        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
        const sorted = [...result.rows].sort((a, b) => (b[alias] ?? 0) - (a[alias] ?? 0));

        const fmt = (r) => `${r[dimension]}: ${round(r[alias])}${field?.format === 'percent' ? '%' : ''} (${r.__rowCount} rows)`;
        const negatives = sorted.filter((r) => r[alias] < 0);
        const extreme = sorted.filter((r) => sd > 0 && Math.abs(r[alias] - mean) > 2 * sd);

        const out = [
          `${useAgg}(${measure}) by ${dimension}: ${result.totalGroups} groups, mean ${round(mean)}, sd ${round(sd)}.`,
          '',
          `Top 5: ${sorted.slice(0, 5).map(fmt).join('; ')}`,
          `Bottom 5: ${sorted.slice(-5).reverse().map(fmt).join('; ')}`,
        ];
        if (negatives.length) out.push('', `${negatives.length} groups are negative: ${negatives.slice(0, 8).map(fmt).join('; ')}`);
        if (extreme.length) out.push('', `More than 2 sd from the mean: ${extreme.map(fmt).join('; ')}`);
        return out.join('\n');
      } catch (e) {
        return e.isSemanticError ? `Rejected: ${e.message}` : `Failed: ${e.message}`;
      }
    },
  });

  return registered;
}

// Where does this value live, if not in the dimension we were asked about?
function findFieldContaining(model, value, exclude) {
  const needle = String(value).toLowerCase();
  for (const dim of model.dimensions()) {
    if (dim.name === exclude || dim.identifierLike || dim.role === ROLE.TIME) continue;
    if (dim.distinctCount > 5000) continue;
    const hit = model.distinctValues(dim.name, 5000).some((v) => String(v.value).toLowerCase() === needle);
    if (hit) return dim.name;
  }
  return null;
}

// Which dimension best explains the variation inside this slice? Prefer the one
// with a workable number of groups and the most spread, but favour the natural
// business hierarchy over incidental fields: breaking a region down by shipping
// class is technically valid and analytically useless.
const HIERARCHY_HINTS = /(categor|sub|product|segment|state|city|region|country|customer|channel|department|brand)/i;

function suggestDrillDimension(model, chart, parentDim, value) {
  const measure = chart.spec.metrics?.[0]?.field;
  if (!measure) return null;

  const candidates = model
    .dimensions()
    .filter((d) => d.name !== parentDim && !d.identifierLike && d.role !== ROLE.TIME)
    .filter((d) => d.distinctCount >= 2 && d.distinctCount <= 40);

  let best = null;
  for (const dim of candidates) {
    try {
      const res = runQuery(model, {
        groupBy: [{ field: dim.name }],
        metrics: chart.spec.metrics,
        filters: [...(chart.spec.filters ?? []), { col: parentDim, op: '=', value }],
      });
      const alias = res.columns[1];
      const vals = res.rows.map((r) => r[alias]).filter((v) => v != null);
      if (vals.length < 2) continue;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      if (!mean) continue;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      // Spread says how much there is to explain; the hierarchy weight says
      // whether the explanation is one a person would care about.
      const score = Math.abs(sd / mean) * (HIERARCHY_HINTS.test(dim.name) ? 2 : 1);
      if (!best || score > best.score) best = { name: dim.name, score };
    } catch {
      // A dimension that cannot be aggregated here is simply not a candidate.
    }
  }
  return best?.name ?? candidates[0]?.name ?? null;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
