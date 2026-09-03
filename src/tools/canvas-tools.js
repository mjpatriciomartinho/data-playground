// WebMCP tools, layer 3: the shared canvas.
//
// This is the collaborative half. The agent adds and edits charts; the human
// drags, filters and pins with the mouse. Both act on the same board, and each
// can see what the other did: list_charts reports the human's filters and
// annotations, and every agent action shows up on screen immediately.

import { fieldSchemas } from './query-tools.js';
import { PRESETS, FONTS } from '../core/theme.js';

import { registerTool } from '../core/registry.js';

export function registerCanvasTools(app, signal) {
  // Nothing to register in a browser without WebMCP; the page still works.
  if (!document.modelContext && !navigator.modelContext) return [];

  const { FILTER_SCHEMA, METRIC_SCHEMA, GROUP_SCHEMA } = fieldSchemas(app.model);

  const registered = [];
  const add = (def) => {
    registerTool(def, { signal });
    registered.push(def.name);
  };

  add({
    name: 'create_chart',
    description:
      'Add a chart to the canvas. Choose the mark and the fields; the page handles layout, colour, ' +
      'number formatting and axis titles. Ratio measures are computed correctly at every level. ' +
      'Returns the chart id and the underlying numbers, so you can describe what the chart shows ' +
      'without calling query_data separately.',
    inputSchema: {
      type: 'object',
      properties: {
        mark: {
          type: 'string',
          enum: ['kpi', 'bar', 'line', 'area', 'pie', 'scatter', 'heatmap', 'map'],
          description:
            'Chart type. "kpi" is a single large number and takes no groupBy; pair it with compare:true for ' +
            'a period-on-period change. "map" is a choropleth and needs a groupBy on a column of places ' +
            '(describe_dataset marks which columns those are). Use line or area for time, and pie only for ' +
            'a handful of parts of a whole.',
        },
        compare: {
          type: 'boolean',
          description: 'For a kpi only: also show the change against the previous period.',
        },
        metrics: METRIC_SCHEMA,
        groupBy: GROUP_SCHEMA,
        filters: FILTER_SCHEMA,
        title: { type: 'string', description: 'Title shown above the chart' },
        limit: { type: 'number', description: 'Maximum categories to plot (default 20)' },
      },
      required: ['mark', 'metrics'],
    },
    execute: async ({ mark, metrics, groupBy = [], filters = [], title, limit = 20, compare = false }) => {
      if (!app.model) return 'No dataset loaded. Ask the user to drop a CSV first.';
      if (mark === 'kpi' && groupBy.length) {
        return 'A "kpi" card shows one number, so it takes no groupBy. Drop the groupBy, or use "bar" instead.';
      }
      if (mark === 'map' && !groupBy.length) {
        return 'A "map" needs a groupBy on a column of places. describe_dataset marks which columns are geographic.';
      }
      try {
        const chart = app.addChart({ mark, metrics, groupBy, filters, title, limit, compare });
        const summary = app.summarise(chart, 12);
        return `Chart "${chart.id}" added to the canvas.\n\n${summary}`;
      } catch (e) {
        return e.isSemanticError ? `Rejected: ${e.message}` : `Could not create the chart: ${e.message}`;
      }
    },
  });

  add({
    name: 'update_chart',
    description:
      'Change an existing chart in place: swap the mark, change the measure, regroup, add or ' +
      'replace filters, rename it. Only the properties you pass are changed. Prefer this over ' +
      'deleting and recreating, so the canvas keeps its layout and the user does not lose their place.',
    inputSchema: {
      type: 'object',
      properties: {
        chartId: { type: 'string' },
        mark: { type: 'string', enum: ['kpi', 'bar', 'line', 'area', 'pie', 'scatter', 'heatmap', 'map'] },
        compare: { type: 'boolean', description: 'For a kpi: show the change against the previous period.' },
        metrics: METRIC_SCHEMA,
        groupBy: GROUP_SCHEMA,
        filters: FILTER_SCHEMA,
        title: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['chartId'],
    },
    execute: async ({ chartId, ...changes }) => {
      if (!app.model) return 'No dataset loaded.';
      const chart = app.getChart(chartId);
      if (!chart) return `No chart "${chartId}". Call list_charts to see what is on the canvas.`;
      try {
        const updated = app.updateChart(chartId, changes);
        return `Updated "${chartId}".\n\n${app.summarise(updated, 12)}`;
      } catch (e) {
        return e.isSemanticError ? `Rejected: ${e.message}` : `Could not update: ${e.message}`;
      }
    },
  });

  add({
    name: 'list_charts',
    description:
      'Report the current state of the canvas: every chart, what it shows, its filters, whether ' +
      'the user pinned it, and any notes attached to it. Call this to find out what the user has ' +
      'been doing by hand before you change anything.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const charts = app.listCharts();
      const active = app.activeFilters();
      const head = active.length
        ? `Global filters set by the user: ${active.map((f) => `${f.col} ${f.op} ${JSON.stringify(f.value)}`).join(', ')}.`
        : 'No global filters set by the user.';
      if (!charts.length) return `${head}\n\nThe canvas is empty.`;
      return [
        head,
        `${charts.length} chart(s) on the canvas:`,
        '',
        ...charts.map((c) => {
          const bits = [`- "${c.id}" [${c.spec.mark}] ${c.spec.title ?? '(untitled)'}`];
          const m = c.spec.metrics.map((x) => `${x.agg}(${x.field})`).join(', ');
          const g = c.spec.groupBy?.map((x) => x.field + (x.grain ? `/${x.grain}` : '')).join(' x ') || 'no grouping';
          bits.push(`    ${m} by ${g}`);
          if (c.spec.filters?.length) bits.push(`    filters: ${c.spec.filters.map((f) => `${f.col} ${f.op} ${JSON.stringify(f.value)}`).join(', ')}`);
          if (c.drillPath?.length) bits.push(`    drill path: ${c.drillPath.join(' > ')}`);
          if (c.pinned) bits.push('    pinned by the user');
          if (c.notes?.length) bits.push(...c.notes.map((n) => `    note (${n.author}): ${n.text}`));
          return bits.join('\n');
        }),
      ].join('\n');
    },
  });

  add({
    name: 'remove_chart',
    description: 'Remove a chart from the canvas. Charts the user pinned are protected and will not be removed.',
    inputSchema: {
      type: 'object',
      properties: { chartId: { type: 'string' } },
      required: ['chartId'],
    },
    execute: async ({ chartId }) => {
      const chart = app.getChart(chartId);
      if (!chart) return `No chart "${chartId}".`;
      if (chart.pinned) return `"${chartId}" is pinned by the user, so it was left alone. Ask them to unpin it first.`;
      app.removeChart(chartId);
      return `Removed "${chartId}".`;
    },
  });

  add({
    name: 'annotate_chart',
    description:
      'Attach a short written note to a chart, visible to the user on the canvas. Use it to record ' +
      'what you found, so the finding survives the conversation and the user can read it later.',
    inputSchema: {
      type: 'object',
      properties: {
        chartId: { type: 'string' },
        text: { type: 'string', description: 'The note, one or two sentences' },
      },
      required: ['chartId', 'text'],
    },
    execute: async ({ chartId, text }) => {
      const chart = app.getChart(chartId);
      if (!chart) return `No chart "${chartId}".`;
      app.annotate(chartId, text, 'agent');
      return `Note added to "${chartId}". The user can see it on the canvas.`;
    },
  });

  add({
    name: 'set_global_filter',
    description:
      'Set or clear the canvas-wide filter that applies to every chart. This is the same control ' +
      'the user operates by hand, so use it when they ask to focus the whole board on a period, ' +
      'region or segment. Pass an empty array to clear.',
    inputSchema: {
      type: 'object',
      properties: { filters: FILTER_SCHEMA },
      required: ['filters'],
    },
    execute: async ({ filters }) => {
      if (!app.model) return 'No dataset loaded.';
      try {
        app.setGlobalFilters(filters);
        const n = app.listCharts().length;
        return filters.length
          ? `Canvas filtered to ${filters.map((f) => `${f.col} ${f.op} ${JSON.stringify(f.value)}`).join(', ')}. All ${n} chart(s) redrawn.`
          : `Cleared the canvas filter. All ${n} chart(s) redrawn.`;
      } catch (e) {
        return `Could not set the filter: ${e.message}`;
      }
    },
  });

  add({
    name: 'set_theme',
    description:
      'Restyle the whole dashboard: the accent colour that carries the data, the colour used for ' +
      'negative values, the paper colour behind everything, and the typeface. Charts, cards and ' +
      'exports all follow, and the chart series are derived from the accent so the board stays ' +
      'coherent. Use this when the user asks for their brand colours, a darker look, or a ' +
      'different feel. Pass only what you want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        accent: { type: 'string', description: 'Hex colour for the main data series and interface accents, e.g. "#1f4f82"' },
        negative: { type: 'string', description: 'Hex colour for losses and negative values' },
        paper: { type: 'string', description: 'Hex colour of the background. A dark value switches the whole page to a dark treatment.' },
        font: { type: 'string', enum: Object.keys(FONTS), description: 'Typeface pairing' },
      },
    },
    execute: async ({ accent, negative, paper, font }) => {
      try {
        const theme = app.setTheme({ accent, negative, paper, font });
        return [
          `Restyled. Accent ${theme.accent}, negative ${theme.negative}, paper ${theme.paper}, ` +
            `typeface "${theme.font}" (${FONTS[theme.font].note}). Every chart and the exports now use these.`,
          app.themeWarning ? `\nWarning: ${app.themeWarning}` : '',
        ]
          .filter(Boolean)
          .join('');
      } catch (e) {
        return `Could not restyle: ${e.message}`;
      }
    },
  });

  add({
    name: 'apply_palette',
    description:
      'Apply one of the page\'s ready-made palettes, each a colour set and typeface chosen to work ' +
      'together. Quicker than set_theme when the user wants a different look but has no specific ' +
      'colours in mind.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: Object.keys(PRESETS),
          description: Object.entries(PRESETS)
            .map(([k, v]) => `${k}: ${v.label}, accent ${v.accent}`)
            .join('; '),
        },
      },
      required: ['name'],
    },
    execute: async ({ name }) => {
      try {
        const theme = app.applyPreset(name);
        return `Applied the "${name}" palette: accent ${theme.accent}, paper ${theme.paper}, typeface "${theme.font}".`;
      } catch (e) {
        return `Could not apply that palette: ${e.message}`;
      }
    },
  });

  add({
    name: 'get_theme',
    description: 'Report the dashboard\'s current colours and typeface, and list the palettes and typefaces available.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const t = app.theme;
      return [
        `Current: accent ${t.accent}, negative ${t.negative}, paper ${t.paper}, typeface "${t.font}".`,
        '',
        'Ready-made palettes:',
        ...Object.entries(PRESETS).map(([k, v]) => `- ${k} (${v.label}): accent ${v.accent}, paper ${v.paper}, typeface ${v.font}`),
        '',
        'Typefaces:',
        ...Object.entries(FONTS).map(([k, v]) => `- ${k} (${v.label}): ${v.note}`),
      ].join('\n');
    },
  });

  return registered;
}
