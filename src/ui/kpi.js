// The big-number card.
//
// A dashboard needs somewhere for the headline to live. One number, set large,
// with the comparison that gives it meaning underneath: a total is not news,
// but a total that is up eleven per cent on last year is.
//
// Deliberately not a chart. Vega would render this as a lonely text mark with
// no advantage, and HTML lets the number scale with the card.

import { runQuery } from '../core/query.js';
import { ROLE } from '../core/model.js';

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) node.append(c);
  return node;
};

export function formatValue(value, field) {
  if (value == null || Number.isNaN(value)) return '—';
  if (field?.format === 'percent') return `${(value * 100).toFixed(1)}%`;

  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const unit = field?.format === 'currency' ? '$' : '';

  // Headline numbers are read, not audited: 1.2M beats 1,234,567 at 44px.
  if (abs >= 1_000_000_000) return `${sign}${unit}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}${unit}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}${unit}${(abs / 1_000).toFixed(0)}K`;
  if (abs >= 1_000) return `${sign}${unit}${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `${sign}${unit}${abs.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/**
 * Compute a KPI: one aggregate over the filtered data, optionally compared with
 * the previous period on a date field.
 */
export function computeKPI(app, spec) {
  const model = app.model;
  const metric = spec.metrics[0];
  const field = model.field(metric.field);

  const base = runQuery(model, {
    metrics: [metric],
    filters: [...app.activeFilters(), ...(spec.filters ?? [])],
  });
  const alias = base.columns[base.columns.length - 1];
  const value = base.rows[0]?.[alias] ?? null;
  const rows = base.rowsScanned;

  let delta = null;
  if (spec.compare) {
    // Compare the most recent period against the one before it, at the grain
    // the card was configured with.
    const timeField = model.dimensions().find((d) => d.role === ROLE.TIME);
    if (timeField) {
      const grain = spec.compareGrain ?? 'year';
      const byPeriod = runQuery(model, {
        groupBy: [{ field: timeField.name, grain }],
        metrics: [metric],
        filters: [...app.activeFilters(), ...(spec.filters ?? [])],
      });
      const periodAlias = byPeriod.columns[byPeriod.columns.length - 1];
      const ordered = [...byPeriod.rows].sort((a, b) => String(a[timeField.name]).localeCompare(String(b[timeField.name])));
      if (ordered.length >= 2) {
        const current = ordered[ordered.length - 1];
        const previous = ordered[ordered.length - 2];
        const cv = current[periodAlias];
        const pv = previous[periodAlias];
        if (pv != null && pv !== 0 && cv != null) {
          // The last period in a file is usually cut off partway through, and
          // comparing a half year against a whole one invents a collapse that
          // did not happen. Detect it and say so rather than reporting it.
          const partial = isPartialPeriod(model, timeField, current[timeField.name], grain);
          delta = {
            pct: (cv - pv) / Math.abs(pv),
            current: cv,
            previous: pv,
            currentLabel: current[timeField.name],
            previousLabel: previous[timeField.name],
            grain,
            partial,
          };
        }
      }
    }
  }

  return { value, rows, delta, field, alias };
}

// Does the newest period run to its natural end, or does the data simply stop
// partway through it? A year that ends in July is not a year that collapsed.
function isPartialPeriod(model, timeField, label, grain) {
  const max = timeField.max;
  if (!max) return false;
  const end = { year: [11, 31], quarter: null, month: null, week: null, day: null }[grain];
  if (grain === 'year') {
    return !(max.getMonth() === end[0] && max.getDate() >= 28);
  }
  if (grain === 'quarter') {
    const lastMonthOfQuarter = Math.floor(max.getMonth() / 3) * 3 + 2;
    return !(max.getMonth() === lastMonthOfQuarter && max.getDate() >= 28);
  }
  if (grain === 'month') {
    const daysInMonth = new Date(max.getFullYear(), max.getMonth() + 1, 0).getDate();
    return max.getDate() < daysInMonth;
  }
  return false;
}

/**
 * Render the KPI card.
 *
 * A small card cannot show everything, so instead of letting the extras spill
 * past the edge it drops them in order of importance: the number always
 * survives, then its label, then the comparison, then the caveat and row count.
 * Clipping is never an acceptable outcome for a number somebody is reading.
 */
export function renderKPI(app, chart, { height } = {}) {
  const box = el('div', { className: 'kpi' });
  // Thresholds measured against the space the chart area actually gets, which
  // is the card minus about 92px of header, spec line and filter row. Each part
  // is admitted only when there is room for it and everything above it.
  const room = (height ?? Infinity) - 92;
  const showLabel = room >= 92;   // number (~46) + label (~18) + gaps
  const showDelta = room >= 150;
  const showCaveat = room >= 215;
  const showRows = room >= 250;
  let result;
  try {
    result = computeKPI(app, chart.spec);
  } catch (e) {
    box.append(el('p', { className: 'panel-error', textContent: e.message }));
    return box;
  }

  const { value, rows, delta, field } = result;

  const figure = el('div', { className: 'kpi-value', textContent: formatValue(value, field) });
  // The number is sized from the card, not the viewport: 7vw is enormous inside
  // a small tile and leaves no room for the label beneath it.
  if (Number.isFinite(room)) {
    const size = Math.max(22, Math.min(64, Math.round(room * 0.42)));
    figure.style.fontSize = `${size}px`;
  }
  if (value != null && value < 0) figure.classList.add('negative');
  box.append(figure);

  const label = chart.spec.metrics[0].agg === 'ratio' ? chart.spec.metrics[0].field : `${chart.spec.metrics[0].agg.toUpperCase()} of ${chart.spec.metrics[0].field}`;
  if (showLabel) box.append(el('div', { className: 'kpi-label', textContent: label }));

  if (delta && showDelta) {
    const up = delta.pct >= 0;
    const line = el('div', { className: `kpi-delta ${delta.partial ? 'partial' : up ? 'up' : 'down'}` });
    line.append(
      el('span', { className: 'kpi-arrow', textContent: up ? '▲' : '▼' }),
      `${Math.abs(delta.pct * 100).toFixed(1)}%`,
      el('span', { className: 'kpi-vs', textContent: `${delta.currentLabel} vs ${delta.previousLabel}` })
    );
    box.append(line);
    if (delta.partial && showCaveat) {
      box.append(
        el('div', {
          className: 'kpi-caveat',
          textContent: `${delta.currentLabel} is incomplete in this data, so the change is not a like-for-like comparison.`,
        })
      );
    }
  }

  if (showRows) box.append(el('div', { className: 'kpi-rows', textContent: `${rows.toLocaleString('en-US')} rows` }));

  // A card too small to show the caveat must not imply the comparison is clean.
  if (delta?.partial && showDelta && !showCaveat) {
    box.querySelector('.kpi-delta')?.setAttribute('title', `${delta.currentLabel} is incomplete in this data.`);
  }
  return box;
}
