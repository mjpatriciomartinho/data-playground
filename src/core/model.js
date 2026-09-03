// The semantic model.
//
// A CSV gives you columns. A semantic model gives you meaning: which columns are
// things you count, which are things you slice by, how each one is allowed to be
// aggregated, and which numbers are ratios that must never be summed.
//
// This is the part Tableau charges for and the part an agent cannot infer on its
// own. The page owns it, and hands it to the agent through the WebMCP tools.

export const ROLE = { MEASURE: 'measure', DIMENSION: 'dimension', TIME: 'time' };

// How a measure may be rolled up.
//  - additive:     safe to SUM across any dimension (revenue, quantity)
//  - semi:         safe to average, meaningless to sum (unit price, discount rate)
//  - ratio:        must be recomputed from its parts, never averaged (profit margin)
export const ADDITIVITY = { ADDITIVE: 'additive', SEMI: 'semi', RATIO: 'ratio' };

const CURRENCY_HINTS = /^(sales|revenue|profit|cost|price|amount|total|spend)/i;
const RATE_HINTS = /(rate|ratio|pct|percent|margin|discount)/i;
const ID_HINTS = /(^|[\s_-])(id|code|zip|postal)([\s_-]|$)/i;
const DATE_HINTS = /(date|day|month|year|time)/i;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

// Parse a date without letting the runtime guess the locale. The Superstore CSV
// ships M/D/YYYY; anything else we accept only in ISO form.
export function parseDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const us = s.match(US_DATE);
  if (us) {
    const [, m, d, y] = us;
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  if (ISO_DATE.test(s)) {
    const dt = new Date(s);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

function isNumeric(raw) {
  if (raw == null || raw === '') return false;
  return !Number.isNaN(Number(String(raw).replace(/[$,\s]/g, '')));
}

export function toNumber(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[$,\s]/g, ''));
  return Number.isNaN(n) ? null : n;
}

// Look at a sample of values and decide what a column actually is.
function profileColumn(name, values) {
  const nonNull = values.filter((v) => v != null && v !== '');
  const nullCount = values.length - nonNull.length;
  const sample = nonNull.slice(0, 500);

  const dateHits = sample.filter((v) => parseDate(v) !== null).length;
  const numHits = sample.filter(isNumeric).length;
  const distinct = new Set(nonNull.map(String));

  const base = { name, nullCount, distinctCount: distinct.size };

  // A column of dates is a time dimension, whatever else it looks like.
  if (sample.length && dateHits / sample.length > 0.9) {
    const times = nonNull.map(parseDate).filter(Boolean).map((d) => d.getTime());
    return {
      ...base,
      role: ROLE.TIME,
      type: 'date',
      min: times.length ? new Date(Math.min(...times)) : null,
      max: times.length ? new Date(Math.max(...times)) : null,
      grains: ['year', 'quarter', 'month', 'week', 'day'],
    };
  }

  if (sample.length && numHits / sample.length > 0.9) {
    // Numeric, but not everything numeric is a measure. Postal codes and row ids
    // are numbers you group by, never numbers you add up.
    const looksLikeId = ID_HINTS.test(name) || DATE_HINTS.test(name);
    const nearlyUnique = distinct.size > nonNull.length * 0.95;
    if (looksLikeId || (nearlyUnique && distinct.size > 50 && !CURRENCY_HINTS.test(name))) {
      return { ...base, role: ROLE.DIMENSION, type: 'string', identifierLike: true };
    }

    const nums = nonNull.map(toNumber).filter((n) => n != null);
    const min = Math.min(...nums);
    const max = Math.max(...nums);

    // A column that never leaves [0,1] and is named like a rate is a rate.
    const looksLikeRate = RATE_HINTS.test(name) || (min >= 0 && max <= 1 && distinct.size < 50);

    return {
      ...base,
      role: ROLE.MEASURE,
      type: 'number',
      additivity: looksLikeRate ? ADDITIVITY.SEMI : ADDITIVITY.ADDITIVE,
      format: CURRENCY_HINTS.test(name) ? 'currency' : looksLikeRate ? 'percent' : 'number',
      defaultAgg: looksLikeRate ? 'avg' : 'sum',
      min,
      max,
    };
  }

  return { ...base, role: ROLE.DIMENSION, type: 'string' };
}

export class SemanticModel {
  constructor(rows, columnNames, { name = 'dataset' } = {}) {
    this.name = name;
    this.rows = rows;
    this.fields = new Map();
    for (const col of columnNames) {
      const values = rows.map((r) => r[col]);
      this.fields.set(col, profileColumn(col, values));
    }
    // Measures the user or the agent defined on top of the raw columns.
    this.calculated = new Map();
  }

  get rowCount() {
    return this.rows.length;
  }

  field(name) {
    return this.fields.get(name) ?? this.calculated.get(name) ?? null;
  }

  fieldNames() {
    return [...this.fields.keys(), ...this.calculated.keys()];
  }

  measures() {
    return this.fieldNames()
      .map((n) => this.field(n))
      .filter((f) => f.role === ROLE.MEASURE);
  }

  dimensions() {
    return this.fieldNames()
      .map((n) => this.field(n))
      .filter((f) => f.role === ROLE.DIMENSION || f.role === ROLE.TIME);
  }

  // Distinct values of a categorical field, most frequent first. This is what
  // stops an agent from filtering on a region that does not exist.
  distinctValues(fieldName, limit = 50) {
    const f = this.field(fieldName);
    if (!f) throw new Error(`No such field: ${fieldName}`);
    const counts = new Map();
    for (const row of this.rows) {
      const v = this.valueOf(row, fieldName);
      if (v == null || v === '') continue;
      const key = f.role === ROLE.TIME ? String(v.getFullYear?.() ?? v) : String(v);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([value, count]) => ({ value, count }));
  }

  // Resolve a field for one row, following calculated-field expressions.
  valueOf(row, fieldName) {
    const calc = this.calculated.get(fieldName);
    if (calc) return calc.rowFn ? calc.rowFn(row, this) : null;
    const f = this.fields.get(fieldName);
    if (!f) return undefined;
    const raw = row[fieldName];
    if (f.role === ROLE.TIME) return parseDate(raw);
    if (f.role === ROLE.MEASURE) return toNumber(raw);
    return raw;
  }

  // Verdict on whether an aggregation makes sense. The tools call this before
  // running anything, so the agent gets corrected instead of quietly misled.
  validateAggregation(fieldName, agg) {
    const f = this.field(fieldName);
    if (!f) return { ok: false, reason: `Unknown field "${fieldName}".` };
    if (agg === 'count') return { ok: true };
    if (f.role !== ROLE.MEASURE) {
      return {
        ok: false,
        reason: `"${fieldName}" is a ${f.role}, not a measure. You can group by it, or use agg "count".`,
      };
    }
    if (f.additivity === ADDITIVITY.RATIO && agg !== 'ratio') {
      return {
        ok: false,
        reason:
          `"${fieldName}" is a ratio (${f.expression}). Averaging or summing a ratio per row gives ` +
          `the wrong answer. It is recomputed from its components automatically, so use agg "ratio".`,
      };
    }
    if (f.additivity === ADDITIVITY.SEMI && agg === 'sum') {
      return {
        ok: false,
        reason:
          `Summing "${fieldName}" is not meaningful: it is a rate, so totals across rows have no ` +
          `interpretation. Use "avg", "min" or "max".`,
      };
    }
    return { ok: true };
  }

  // A ratio measure: numerator and denominator are aggregated first, divided after.
  // SUM(Profit)/SUM(Sales), never AVG(Profit/Sales).
  defineRatio(name, { numerator, denominator, description = '', format = 'percent' }) {
    for (const part of [numerator, denominator]) {
      const f = this.field(part);
      if (!f || f.role !== ROLE.MEASURE) {
        throw new Error(`Ratio "${name}" needs measures; "${part}" is not one.`);
      }
    }
    const def = {
      name,
      role: ROLE.MEASURE,
      type: 'number',
      additivity: ADDITIVITY.RATIO,
      format,
      defaultAgg: 'ratio',
      numerator,
      denominator,
      description,
      expression: `SUM(${numerator}) / SUM(${denominator})`,
      calculated: true,
    };
    this.calculated.set(name, def);
    return def;
  }

  // A row-level derived column: evaluated per row, then aggregated normally.
  defineDerived(name, { rowFn, expression, description = '', role = ROLE.MEASURE, format = 'number', additivity = ADDITIVITY.ADDITIVE }) {
    const def = {
      name,
      role,
      type: role === ROLE.MEASURE ? 'number' : 'string',
      additivity: role === ROLE.MEASURE ? additivity : undefined,
      defaultAgg: role === ROLE.MEASURE ? (additivity === ADDITIVITY.ADDITIVE ? 'sum' : 'avg') : undefined,
      format,
      description,
      expression,
      rowFn,
      calculated: true,
    };
    this.calculated.set(name, def);
    return def;
  }

  // A compact description of the whole model, written for a language model to read.
  describe() {
    const fmt = (f) => {
      const bits = [`"${f.name}"`, f.role];
      if (f.role === ROLE.MEASURE) {
        bits.push(f.additivity, `default agg: ${f.defaultAgg}`);
        if (f.expression) bits.push(`= ${f.expression}`);
        if (f.min != null) bits.push(`range ${round(f.min)}..${round(f.max)}`);
      }
      if (f.role === ROLE.TIME && f.min) {
        bits.push(`${f.min.toISOString().slice(0, 10)} to ${f.max.toISOString().slice(0, 10)}`);
        bits.push(`grains: ${f.grains.join(', ')}`);
      }
      if (f.role === ROLE.DIMENSION) bits.push(`${f.distinctCount} distinct`);
      if (f.geo) bits.push(`geographic (${f.geo}) — can be drawn as a map`);
      if (f.nullCount) bits.push(`${f.nullCount} empty`);
      if (f.description) bits.push(f.description);
      return `- ${bits.join(' | ')}`;
    };

    return [
      `Dataset "${this.name}": ${this.rowCount} rows, ${this.fieldNames().length} fields.`,
      '',
      'MEASURES (things to aggregate):',
      ...this.measures().map(fmt),
      '',
      'DIMENSIONS (things to group or filter by):',
      ...this.dimensions().map(fmt),
      '',
      'Aggregation rules enforced by this page:',
      '- "additive" measures may be summed or averaged.',
      '- "semi" measures are rates: average them, never sum them.',
      '- "ratio" measures are recomputed as SUM(numerator)/SUM(denominator); pass agg "ratio".',
    ].join('\n');
  }
}

function round(n) {
  return Math.round(n * 100) / 100;
}
