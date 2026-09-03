// The query engine. Group, filter, aggregate, drill down.
//
// Everything runs over the in-memory rows. No SQL, no network, no worker round
// trip: the dataset never leaves this tab, and the agent only ever receives the
// aggregated result, never the rows that produced it.

import { ROLE, ADDITIVITY, parseDate } from './model.js';

export const OPERATORS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'not in', 'contains', 'between'];

const GRAIN_KEY = {
  year: (d) => String(d.getFullYear()),
  quarter: (d) => `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`,
  month: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
  week: (d) => {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t - start) / 86400000 + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  },
  day: (d) => d.toISOString().slice(0, 10),
};

// Turn a filter into a predicate. Time fields compare against the grain key when
// the filter value looks like one ("2016", "2016-Q3"), and against real dates
// otherwise, so both "year = 2016" and "date >= 2016-06-01" work.
function buildPredicate(model, filter) {
  const { col, op, value } = filter;
  const field = model.field(col);
  if (!field) throw new Error(`Cannot filter on unknown field "${col}".`);
  if (!OPERATORS.includes(op)) {
    throw new Error(`Unknown operator "${op}". Use one of: ${OPERATORS.join(', ')}.`);
  }

  const isTime = field.role === ROLE.TIME;
  const grainish = (v) => typeof v === 'string' && /^\d{4}(-(Q\d|W\d{2}|\d{2}))?$/.test(v);

  const norm = (raw) => {
    if (raw == null) return null;
    if (!isTime) return field.role === ROLE.MEASURE ? Number(raw) : String(raw);
    return raw instanceof Date ? raw : parseDate(raw);
  };

  const cellFor = (row) => {
    const v = model.valueOf(row, col);
    if (!isTime) return field.role === ROLE.MEASURE ? v : v == null ? null : String(v);
    return v;
  };

  // Comparing a time field against "2016" or "2016-03": match on the grain key.
  const grainMatch = (() => {
    if (!isTime) return null;
    const vals = Array.isArray(value) ? value : [value];
    if (!vals.every(grainish)) return null;
    const len = String(vals[0]).length;
    const grain = len === 4 ? 'year' : String(vals[0]).includes('Q') ? 'quarter' : String(vals[0]).includes('W') ? 'week' : 'month';
    return { grain, set: new Set(vals.map(String)) };
  })();

  return (row) => {
    const cell = cellFor(row);
    if (cell == null) return false;

    if (grainMatch) {
      const key = GRAIN_KEY[grainMatch.grain](cell);
      switch (op) {
        case '=':
        case 'in':
          return grainMatch.set.has(key);
        case '!=':
        case 'not in':
          return !grainMatch.set.has(key);
        default: {
          const target = [...grainMatch.set][0];
          if (op === '>') return key > target;
          if (op === '>=') return key >= target;
          if (op === '<') return key < target;
          if (op === '<=') return key <= target;
          return false;
        }
      }
    }

    switch (op) {
      case '=':
        return cell instanceof Date ? cell.getTime() === norm(value)?.getTime() : cell === norm(value);
      case '!=':
        return cell instanceof Date ? cell.getTime() !== norm(value)?.getTime() : cell !== norm(value);
      case '>':
        return cell > norm(value);
      case '>=':
        return cell >= norm(value);
      case '<':
        return cell < norm(value);
      case '<=':
        return cell <= norm(value);
      case 'in':
        return (Array.isArray(value) ? value : [value]).map(norm).some((v) =>
          cell instanceof Date ? cell.getTime() === v?.getTime() : cell === v
        );
      case 'not in':
        return !(Array.isArray(value) ? value : [value]).map(norm).some((v) =>
          cell instanceof Date ? cell.getTime() === v?.getTime() : cell === v
        );
      case 'contains':
        return String(cell).toLowerCase().includes(String(value).toLowerCase());
      case 'between': {
        const [lo, hi] = (Array.isArray(value) ? value : [value, value]).map(norm);
        return cell >= lo && cell <= hi;
      }
      default:
        return false;
    }
  };
}

export function applyFilters(model, rows, filters = []) {
  if (!filters.length) return rows;
  const preds = filters.map((f) => buildPredicate(model, f));
  return rows.filter((row) => preds.every((p) => p(row)));
}

// Key a row by a dimension, honouring the requested time grain.
function groupKey(model, row, spec) {
  const field = model.field(spec.field);
  const v = model.valueOf(row, spec.field);
  if (v == null || v === '') return null;
  if (field.role === ROLE.TIME) {
    const grain = spec.grain ?? 'year';
    const fn = GRAIN_KEY[grain];
    if (!fn) throw new Error(`Unknown time grain "${grain}". Use: ${Object.keys(GRAIN_KEY).join(', ')}.`);
    return fn(v);
  }
  return String(v);
}

function aggregate(values, agg) {
  if (!values.length) return null;
  switch (agg) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'count':
      return values.length;
    default:
      throw new Error(`Unknown aggregation "${agg}".`);
  }
}

/**
 * Run a query against the model.
 *
 * @param {SemanticModel} model
 * @param {object} spec
 * @param {Array<{field:string, grain?:string}>} spec.groupBy
 * @param {Array<{field:string, agg:string, alias?:string}>} spec.metrics
 * @param {Array<{col:string, op:string, value:*}>} spec.filters
 * @param {{by?:string, dir?:'asc'|'desc'}} spec.sort
 * @param {number} spec.limit
 */
export function runQuery(model, spec) {
  const groupBy = (spec.groupBy ?? []).map((g) => (typeof g === 'string' ? { field: g } : g));
  const metrics = (spec.metrics ?? []).map((m) => (typeof m === 'string' ? { field: m, agg: 'sum' } : m));
  const filters = spec.filters ?? [];

  if (!metrics.length) throw new Error('A query needs at least one metric.');

  // Validate before touching data, so a bad aggregation is explained rather than
  // silently computed.
  for (const m of metrics) {
    const verdict = model.validateAggregation(m.field, m.agg);
    if (!verdict.ok) {
      const err = new Error(verdict.reason);
      err.isSemanticError = true;
      throw err;
    }
  }

  const rows = applyFilters(model, model.rows, filters);

  // No grouping: one total row.
  const buckets = new Map();
  if (!groupBy.length) {
    buckets.set('__all__', { keys: {}, rows });
  } else {
    for (const row of rows) {
      const parts = [];
      let skip = false;
      const keys = {};
      for (const g of groupBy) {
        const k = groupKey(model, row, g);
        if (k == null) {
          skip = true;
          break;
        }
        keys[g.field] = k;
        parts.push(k);
      }
      if (skip) continue;
      const id = parts.join('  ');
      let bucket = buckets.get(id);
      if (!bucket) {
        bucket = { keys, rows: [] };
        buckets.set(id, bucket);
      }
      bucket.rows.push(row);
    }
  }

  const out = [];
  for (const bucket of buckets.values()) {
    const rec = { ...bucket.keys };
    for (const m of metrics) {
      const alias = m.alias ?? (m.agg === 'count' ? 'count' : `${m.agg}(${m.field})`);
      const field = model.field(m.field);

      if (field?.additivity === ADDITIVITY.RATIO || m.agg === 'ratio') {
        // Aggregate the parts, then divide. This is the whole point.
        const num = bucket.rows.map((r) => model.valueOf(r, field.numerator)).filter((v) => v != null);
        const den = bucket.rows.map((r) => model.valueOf(r, field.denominator)).filter((v) => v != null);
        const d = aggregate(den, 'sum');
        rec[alias] = d ? aggregate(num, 'sum') / d : null;
        continue;
      }

      if (m.agg === 'count') {
        rec[alias] = bucket.rows.length;
        continue;
      }

      const vals = bucket.rows.map((r) => model.valueOf(r, m.field)).filter((v) => v != null && !Number.isNaN(v));
      rec[alias] = aggregate(vals, m.agg);
    }
    rec.__rowCount = bucket.rows.length;
    out.push(rec);
  }

  // Sort: by an explicit field, else by the first metric descending.
  const firstAlias = metrics[0].alias ?? (metrics[0].agg === 'count' ? 'count' : `${metrics[0].agg}(${metrics[0].field})`);
  const sortBy = spec.sort?.by ?? firstAlias;
  const dir = spec.sort?.dir ?? (groupBy.some((g) => model.field(g.field)?.role === ROLE.TIME) ? 'asc' : 'desc');
  const timeSort = groupBy.length === 1 && model.field(groupBy[0].field)?.role === ROLE.TIME && !spec.sort?.by;
  const key = timeSort ? groupBy[0].field : sortBy;

  out.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return dir === 'asc' ? cmp : -cmp;
  });

  const limited = spec.limit ? out.slice(0, spec.limit) : out;

  return {
    rows: limited,
    totalGroups: out.length,
    rowsScanned: rows.length,
    rowsInDataset: model.rows.length,
    columns: [...groupBy.map((g) => g.field), ...metrics.map((m) => m.alias ?? (m.agg === 'count' ? 'count' : `${m.agg}(${m.field})`))],
  };
}

// Render a result as a small text table. This is what goes to the model: the
// shape of the answer, never the underlying rows.
export function formatResult(model, result, { maxRows = 25 } = {}) {
  const cols = result.columns;
  const shown = result.rows.slice(0, maxRows);
  if (!shown.length) return 'No rows matched.';

  const fmtCell = (rec, col) => {
    const v = rec[col];
    if (v == null) return '';
    if (typeof v !== 'number') return String(v);
    const field = model.field(col.replace(/^\w+\((.*)\)$/, '$1'));
    if (field?.format === 'percent') return `${(v * 100).toFixed(1)}%`;
    if (field?.format === 'currency') return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(Math.round(v * 100) / 100);
  };

  const widths = cols.map((c) => Math.max(c.length, ...shown.map((r) => fmtCell(r, c).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');

  const body = [line(cols), line(widths.map((w) => '-'.repeat(w))), ...shown.map((r) => line(cols.map((c) => fmtCell(r, c))))];

  const notes = [];
  if (result.totalGroups > shown.length) notes.push(`${result.totalGroups} groups total, showing ${shown.length}.`);
  notes.push(`Computed over ${result.rowsScanned.toLocaleString('en-US')} of ${result.rowsInDataset.toLocaleString('en-US')} rows, in the browser.`);

  // Grouping by a raw numeric column gives one group per distinct value, which
  // is rarely what was wanted and tempts an agent into totalling the groups by
  // hand in its reply. Those hand totals are computed over rows it cannot see,
  // so they come back rounded or wrong. Point at the tool that does it properly.
  const grouped = cols[0];
  const gField = model.field(grouped);
  if (gField?.role === ROLE.MEASURE && result.totalGroups > 5) {
    notes.push(
      `Note: "${grouped}" is a numeric measure, so this is one group per distinct value ` +
        `(${result.totalGroups} of them). If you want ranges or bands, call ` +
        `define_calculated_field with bucket(${grouped}, ...) and group by the field it creates. ` +
        `Do not add the groups up yourself: that arithmetic runs on rows you cannot see.`
    );
  }

  return [...body, '', ...notes].join('\n');
}
