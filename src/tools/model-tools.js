// WebMCP tools, layer 1: the semantic model.
//
// These are the tools that make the difference. An agent pointed at a raw CSV
// guesses column names, sums things that must not be summed, and averages
// ratios. These tools stop all three, because the page knows what the data
// means and says so.

import { ROLE, ADDITIVITY, parseDate, toNumber } from '../core/model.js';
import { fieldSchemas } from './query-tools.js';

import { registerTool } from '../core/registry.js';

export function registerModelTools(app, signal) {
  // Nothing to register in a browser without WebMCP; the page still works.
  if (!document.modelContext && !navigator.modelContext) return [];

  // Real field names, so the agent picks from a list instead of guessing.
  const { measures, dimensions } = fieldSchemas(app.model);
  const enumOrString = (names, description) =>
    names.length ? { type: 'string', enum: names, description } : { type: 'string', description };

  const registered = [];
  const add = (def) => {
    registerTool(def, { signal });
    registered.push(def.name);
  };

  add({
    name: 'describe_dataset',
    description:
      'Describe the loaded dataset: every field, whether it is a measure or a dimension, how each ' +
      'measure may legally be aggregated, date ranges, and cardinality. Call this before any other ' +
      'data tool. Returns only metadata and aggregate statistics, never the underlying rows.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      if (!app.model) return 'No dataset loaded yet. Ask the user to drop a CSV, or call load_sample_dataset.';
      const active = app.activeFilters();
      const filterNote = active.length
        ? `\n\nFILTERS THE USER SET BY HAND (these apply to every query unless you override them):\n` +
          active.map((f) => `- ${f.col} ${f.op} ${JSON.stringify(f.value)}`).join('\n')
        : '\n\nNo filters currently set by the user.';
      return app.model.describe() + filterNote;
    },
  });

  add({
    name: 'get_field_values',
    description:
      'List the distinct values of a dimension, most frequent first, with row counts. Use this ' +
      'before filtering on a field so you filter on values that actually exist.',
    inputSchema: {
      type: 'object',
      properties: {
        field: enumOrString(dimensions, 'Name of the dimension field'),
        limit: { type: 'number', description: 'How many values to return (default 30)' },
      },
      required: ['field'],
    },
    annotations: { readOnlyHint: true },
    execute: async ({ field, limit = 30 }) => {
      if (!app.model) return 'No dataset loaded.';
      const f = app.model.field(field);
      if (!f) {
        return `No field named "${field}". Available fields: ${app.model.fieldNames().join(', ')}.`;
      }
      const vals = app.model.distinctValues(field, limit);
      const head = `"${field}" has ${f.distinctCount} distinct values. Top ${vals.length}:`;
      return [head, ...vals.map((v) => `- ${v.value} (${v.count.toLocaleString('en-US')} rows)`)].join('\n');
    },
  });

  add({
    name: 'define_ratio_measure',
    description:
      'Define a ratio measure such as profit margin. The page computes it as SUM(numerator) / ' +
      'SUM(denominator) at every aggregation level, which is the correct way; averaging a ' +
      'per-row ratio gives a different and wrong number. Once defined, the measure is available ' +
      'to every chart and query, and appears in the user interface.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the new measure, e.g. "Profit Margin"' },
        numerator: enumOrString(measures, 'Existing measure for the top of the fraction'),
        denominator: enumOrString(measures, 'Existing measure for the bottom'),
        description: { type: 'string', description: 'What this measure means, for future reference' },
      },
      required: ['name', 'numerator', 'denominator'],
    },
    execute: async ({ name, numerator, denominator, description = '' }) => {
      if (!app.model) return 'No dataset loaded.';
      try {
        const def = app.model.defineRatio(name, { numerator, denominator, description });
        app.onModelChanged();
        return `Defined "${name}" = ${def.expression}. It is now in the field list and can be used in query_data and create_chart with agg "ratio".`;
      } catch (e) {
        return `Could not define the measure: ${e.message}`;
      }
    },
  });

  add({
    name: 'define_calculated_field',
    description:
      'Create a new field derived from existing ones, using a small safe expression language. ' +
      'Supported forms: arithmetic between numeric fields and constants, e.g. "Profit / Quantity"; ' +
      'date difference in days, e.g. "days_between(Order Date, Ship Date)"; and a bucketing form, ' +
      'e.g. "bucket(Discount, 0, 0.2, 0.4)" which labels each row by which range it falls into. ' +
      'Reference fields by their exact name. The new field joins the model permanently. ' +
      'ALWAYS use this when the user asks for grouped ranges, bands, tiers, buckets or ' +
      'categories that are not already a column: call it first, then group by the field it ' +
      'creates. Do NOT group by the raw numeric column and total the groups yourself. Doing ' +
      'the arithmetic in your reply is wrong: it is computed over rows you cannot see, so your ' +
      'totals will be rounded or mistaken, and the number will not match the chart. This tool ' +
      'is available whenever a dataset is loaded; if a call fails, report the error verbatim ' +
      'rather than working around it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the new field' },
        expression: { type: 'string', description: 'The expression, see the description for supported forms' },
        description: { type: 'string', description: 'What it means' },
      },
      required: ['name', 'expression'],
    },
    execute: async ({ name, expression, description = '' }) => {
      if (!app.model) return 'No dataset loaded.';
      try {
        const def = compileExpression(app.model, name, expression, description);
        app.onModelChanged();
        const kind = def.role === ROLE.MEASURE ? `measure (${def.additivity})` : 'dimension';
        return `Created ${kind} "${name}" = ${expression}. Available to every chart and query from now on.`;
      } catch (e) {
        return `Could not create the field: ${e.message}`;
      }
    },
  });

  return registered;
}

// A deliberately tiny expression compiler. No eval, no arbitrary code: three
// recognised shapes, each producing a per-row function.
function compileExpression(model, name, expression, description) {
  const expr = expression.trim();

  // days_between(A, B)
  const days = expr.match(/^days_between\(\s*(.+?)\s*,\s*(.+?)\s*\)$/i);
  if (days) {
    const [, a, b] = days;
    for (const f of [a, b]) {
      const fld = model.field(f);
      if (!fld || fld.role !== ROLE.TIME) throw new Error(`"${f}" is not a date field.`);
    }
    return model.defineDerived(name, {
      rowFn: (row, m) => {
        const d1 = m.valueOf(row, a);
        const d2 = m.valueOf(row, b);
        if (!d1 || !d2) return null;
        return Math.round((d2 - d1) / 86400000);
      },
      expression: expr,
      description,
      role: ROLE.MEASURE,
      additivity: ADDITIVITY.SEMI,
      format: 'number',
    });
  }

  // bucket(Field, edge, edge, ...)
  const bucket = expr.match(/^bucket\(\s*(.+?)\s*,\s*(.+)\)$/i);
  if (bucket) {
    const [, fieldName, edgeStr] = bucket;
    const fld = model.field(fieldName);
    if (!fld || fld.role !== ROLE.MEASURE) throw new Error(`"${fieldName}" is not a numeric field.`);
    const edges = edgeStr.split(',').map((s) => Number(s.trim()));
    if (edges.some(Number.isNaN)) throw new Error('Bucket edges must be numbers.');
    return model.defineDerived(name, {
      rowFn: (row, m) => {
        const v = m.valueOf(row, fieldName);
        if (v == null) return null;
        for (let i = edges.length - 1; i >= 0; i--) {
          if (v >= edges[i]) return i === edges.length - 1 ? `${edges[i]}+` : `${edges[i]}-${edges[i + 1]}`;
        }
        return `<${edges[0]}`;
      },
      expression: expr,
      description,
      role: ROLE.DIMENSION,
    });
  }

  // Arithmetic: field/constant separated by + - * /
  const tokens = expr.split(/\s*([+\-*/])\s*/).filter(Boolean);
  if (tokens.length >= 3 && tokens.length % 2 === 1) {
    const operands = tokens.filter((_, i) => i % 2 === 0);
    const ops = tokens.filter((_, i) => i % 2 === 1);
    for (const o of operands) {
      if (Number.isNaN(Number(o))) {
        const fld = model.field(o);
        if (!fld || fld.role !== ROLE.MEASURE) {
          throw new Error(`"${o}" is not a numeric field. Available measures: ${model.measures().map((m) => m.name).join(', ')}.`);
        }
      }
    }
    return model.defineDerived(name, {
      rowFn: (row, m) => {
        const val = (o) => (Number.isNaN(Number(o)) ? m.valueOf(row, o) : Number(o));
        let acc = val(operands[0]);
        if (acc == null) return null;
        for (let i = 0; i < ops.length; i++) {
          const rhs = val(operands[i + 1]);
          if (rhs == null) return null;
          if (ops[i] === '+') acc += rhs;
          else if (ops[i] === '-') acc -= rhs;
          else if (ops[i] === '*') acc *= rhs;
          else acc = rhs === 0 ? null : acc / rhs;
          if (acc == null) return null;
        }
        return acc;
      },
      expression: expr,
      description,
      role: ROLE.MEASURE,
      // A per-row division is a rate: averaging is defensible, summing is not.
      additivity: ops.includes('/') ? ADDITIVITY.SEMI : ADDITIVITY.ADDITIVE,
    });
  }

  throw new Error(
    `Could not parse "${expression}". Supported: arithmetic ("Profit / Quantity"), ` +
      `days_between(DateA, DateB), or bucket(Field, 0, 0.2, 0.4).`
  );
}
