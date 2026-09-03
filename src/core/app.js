// Application state: the model, the canvas, and the filters both parties share.
//
// Everything the agent does goes through here, and so does everything the human
// does with the mouse. One state, two operators. That is the collaboration.

import { SemanticModel } from './model.js';
import { runQuery, formatResult } from './query.js';
import { parseCSV } from './csv.js';
import { ToolRegistry } from './registry.js';
import { detectGeo } from './geo.js';
import { findSlot, defaultSize, clampToCanvas } from '../ui/layout.js';
import { DEFAULT_THEME, PRESETS, FONTS, normaliseHex, derive } from './theme.js';
import { pieDowngradedToBars } from './vega.js';

let nextId = 1;

export class App {
  constructor() {
    this.model = null;
    this.charts = [];
    this.globalFilters = [];
    this.registry = new ToolRegistry(this);
    this.listeners = new Set();
    this.activityLog = [];
    this.bytesUploaded = 0; // stays at zero, and the UI says so
    // The canvas is a fixed shape, chosen by the user, and cards carry
    // positions on it. Layout is part of the document, not a side effect of
    // the window width.
    this.canvas = { id: '1920x1080', width: 1920, height: 1080 };
    this.theme = { ...DEFAULT_THEME };
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(kind = 'change') {
    for (const fn of this.listeners) fn(kind, this);
  }

  log(actor, text) {
    this.activityLog.unshift({ actor, text, at: new Date() });
    this.activityLog = this.activityLog.slice(0, 60);
    this.emit('log');
  }

  // ---- data loading -------------------------------------------------------

  loadFromText(text, name) {
    const { header, rows } = parseCSV(text);
    if (!rows.length) throw new Error('No data rows found in the file.');
    this.model = new SemanticModel(rows, header, { name });
    // Mark the columns that are places, so both the interface and the agent
    // know a map is on the table without each working it out again.
    for (const dim of this.model.dimensions()) {
      const geo = detectGeo(this.model, dim.name);
      if (geo) dim.geo = geo.kind;
    }
    this.charts = [];
    this.globalFilters = [];
    this.registry.registerDataTools();
    this.log('human', `Loaded ${name}: ${rows.length.toLocaleString('en-US')} rows, parsed in this tab.`);
    this.emit('model');
    return this.model.describe();
  }

  async loadSample() {
    const res = await fetch('./public/superstore.csv');
    if (!res.ok) throw new Error('Could not read the bundled sample.');
    const text = await res.text();
    const summary = this.loadFromText(text, 'Sample retail orders');
    // A ratio the dataset cannot express on its own, seeded so the guardrail has
    // something real to protect from the first minute.
    this.model.defineRatio('Profit Margin', {
      numerator: 'Profit',
      denominator: 'Sales',
      description: 'Profit as a share of sales',
    });
    this.registry.registerDataTools();
    this.emit('model');
    return summary;
  }

  onModelChanged() {
    // New calculated fields must reach the agent's schemas, which means
    // re-registering the data tools with the updated field list.
    this.registry.registerDataTools();
    this.emit('model');
  }

  onToolsChanged(names) {
    this.activeTools = names;
    this.emit('tools');
  }

  // ---- filters ------------------------------------------------------------

  activeFilters() {
    return this.globalFilters;
  }

  setGlobalFilters(filters, actor = 'agent') {
    // Validate before committing, so a bad filter never half-applies.
    if (filters.length) runQuery(this.model, { metrics: [{ field: this.model.measures()[0].name, agg: 'count' }], filters });
    this.globalFilters = filters;
    this.log(actor, filters.length ? `Filtered the canvas: ${filters.map((f) => `${f.col} ${f.op} ${JSON.stringify(f.value)}`).join(', ')}` : 'Cleared the canvas filter');
    this.emit('filters');
    return this.globalFilters;
  }

  // ---- theme --------------------------------------------------------------

  setTheme(changes, actor = 'human') {
    const next = { ...this.theme };
    for (const key of ['accent', 'negative', 'paper']) {
      if (changes[key] == null) continue;
      const hex = normaliseHex(changes[key]);
      if (!hex) throw new Error(`"${changes[key]}" is not a colour. Use a hex value such as #1f4f82.`);
      next[key] = hex;
    }
    if (changes.font != null) {
      if (!FONTS[changes.font]) {
        throw new Error(`Unknown typeface "${changes.font}". Available: ${Object.keys(FONTS).join(', ')}.`);
      }
      next.font = changes.font;
    }
    this.theme = next;
    this.themeWarning = derive(next).accentClashesWithNegative
      ? 'The accent and the loss colour are nearly the same, so gains and losses will look alike.'
      : null;
    const described = Object.entries(changes)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    this.log(actor, `Restyled the dashboard: ${described}`);
    this.emit('theme');
    return this.theme;
  }

  applyPreset(name, actor = 'human') {
    const preset = PRESETS[name];
    if (!preset) throw new Error(`Unknown palette "${name}". Available: ${Object.keys(PRESETS).join(', ')}.`);
    const { label, ...rest } = preset;
    this.theme = { ...rest };
    this.log(actor, `Applied the ${label} palette`);
    this.emit('theme');
    return this.theme;
  }

  // ---- charts -------------------------------------------------------------

  addChart(spec, extra = {}) {
    const normalised = {
      mark: spec.mark ?? 'bar',
      metrics: (spec.metrics ?? []).map((m) => (typeof m === 'string' ? { field: m, agg: 'sum' } : m)),
      groupBy: (spec.groupBy ?? []).map((g) => (typeof g === 'string' ? { field: g } : g)),
      filters: spec.filters ?? [],
      compare: spec.compare ?? false,
      title: spec.title,
      limit: spec.limit ?? 20,
    };
    // Run it once now so an invalid spec fails here, not silently on screen.
    this.evaluate(normalised);

    const chart = { id: `chart_${nextId++}`, spec: normalised, notes: [], pinned: false, ...extra };
    // Anything arriving without a position gets the first free rectangle, so a
    // chart an agent creates never lands on top of the user's work.
    if (!chart.box) {
      chart.box = findSlot(this.charts, this.canvas, defaultSize(normalised.mark, this.canvas));
    }
    this.charts.push(chart);
    this.log('agent', `Added ${normalised.mark} chart: ${normalised.title ?? describeSpec(normalised)}`);
    this.emit('charts');
    return chart;
  }

  updateChart(id, changes) {
    const chart = this.getChart(id);
    if (!chart) throw new Error(`No chart ${id}`);
    const spec = { ...chart.spec };
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined) continue;
      if (k === 'metrics') spec.metrics = v.map((m) => (typeof m === 'string' ? { field: m, agg: 'sum' } : m));
      else if (k === 'groupBy') spec.groupBy = v.map((g) => (typeof g === 'string' ? { field: g } : g));
      else spec[k] = v;
    }
    this.evaluate(spec);
    chart.spec = spec;
    this.log('agent', `Updated ${id}: ${spec.title ?? describeSpec(spec)}`);
    this.emit('charts');
    return chart;
  }

  removeChart(id) {
    this.charts = this.charts.filter((c) => c.id !== id);
    this.log('agent', `Removed ${id}`);
    this.emit('charts');
  }

  clearCharts(actor = 'human') {
    const n = this.charts.length;
    this.charts = [];
    this.log(actor, `Cleared the dashboard (${n} chart${n === 1 ? '' : 's'})`);
    this.emit('charts');
  }

  // ---- canvas -------------------------------------------------------------

  setCanvasSize(preset) {
    const prev = this.canvas;
    this.canvas = { id: preset.id, width: preset.width, height: preset.height };
    // Rescale what is already placed, so changing shape rearranges the board
    // rather than throwing half of it off the edge.
    const sx = preset.width / prev.width;
    const sy = preset.height / prev.height;
    for (const c of this.charts) {
      if (!c.box) continue;
      c.box = {
        x: Math.round(c.box.x * sx),
        y: Math.round(c.box.y * sy),
        width: Math.round(c.box.width * sx),
        height: Math.round(c.box.height * sy),
      };
    }
    this.log('human', `Canvas set to ${preset.width} × ${preset.height}`);
    this.emit('charts');
  }

  // Move or resize one card. Positions are canvas pixels, not screen pixels.
  // The clamp happens here rather than only in the drag handler, so a box set
  // from anywhere (an agent, a restored layout, a test) still respects the
  // minimum that keeps the card readable.
  setChartBox(id, box) {
    const chart = this.getChart(id);
    if (!chart) return;
    chart.box = clampToCanvas(box, this.canvas, chart.spec.mark);
    this.emit('layout');
    return chart.box;
  }

  // Raise a card above the others. With free placement, overlap is allowed and
  // stacking order becomes something the user needs to control.
  bringToFront(id) {
    const from = this.charts.findIndex((c) => c.id === id);
    if (from < 0 || from === this.charts.length - 1) return;
    const [moved] = this.charts.splice(from, 1);
    this.charts.push(moved);
    this.emit('charts');
  }

  getChart(id) {
    return this.charts.find((c) => c.id === id) ?? null;
  }

  listCharts() {
    return this.charts;
  }

  annotate(id, text, author) {
    const chart = this.getChart(id);
    if (!chart) return null;
    chart.notes.push({ text, author, at: new Date() });
    this.log(author, `Note on ${id}: ${text}`);
    this.emit('charts');
    return chart;
  }

  togglePin(id) {
    const chart = this.getChart(id);
    if (!chart) return;
    chart.pinned = !chart.pinned;
    this.log('human', `${chart.pinned ? 'Pinned' : 'Unpinned'} ${id}`);
    this.emit('charts');
  }

  // Run a chart's spec against the model, with the global filters folded in.
  evaluate(spec) {
    return runQuery(this.model, {
      ...spec,
      filters: [...this.globalFilters, ...(spec.filters ?? [])],
    });
  }

  summarise(chart, maxRows = 12) {
    const result = this.evaluate(chart.spec);
    const body = formatResult(this.model, result, { maxRows });
    // The page silently substitutes bars for a pie of negative values and says
    // so on the chart. An agent cannot read a chart title, so tell it here too:
    // otherwise it describes a pie that is not on screen.
    if (pieDowngradedToBars(chart.spec, result)) {
      return (
        body +
        '\n\nNote: you asked for a pie, but this data contains negative values and a pie ' +
        'encodes magnitude as area, so it cannot show them. The page drew a bar chart instead ' +
        'and labelled it as such. Describe it as a bar chart.'
      );
    }
    return body;
  }
}

function describeSpec(spec) {
  const m = spec.metrics.map((x) => `${x.agg}(${x.field})`).join(', ');
  const g = spec.groupBy?.map((x) => x.field).join(' x ');
  return g ? `${m} by ${g}` : m;
}
