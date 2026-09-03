// The chart panel: the single place a person makes a chart.
//
// There used to be three entry points competing for the same job, which meant
// the interface never said what it wanted you to do. Now there is one button,
// and it opens this. The panel shows a live preview, so you commit to a chart
// you have already seen rather than guessing from four dropdowns.

import { ROLE } from '../core/model.js';
import { toVegaLite } from '../core/vega.js';
import { detectGeo } from '../core/geo.js';
import { renderKPI } from './kpi.js';
import { filterEditor, describeFilter } from './filters.js';

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) node.append(c);
  return node;
};

const MARKS = [
  { id: 'kpi', label: 'Number', glyph: '#' },
  { id: 'bar', label: 'Bar', glyph: '▮' },
  { id: 'line', label: 'Line', glyph: '⁄' },
  { id: 'area', label: 'Area', glyph: '◣' },
  { id: 'pie', label: 'Pie', glyph: '◔' },
  { id: 'scatter', label: 'Points', glyph: '⁘' },
  { id: 'heatmap', label: 'Heat', glyph: '▦' },
  { id: 'map', label: 'Map', glyph: '◍' },
];

// Which aggregations make sense for a field. The illegal option is never shown,
// rather than shown and then rejected.
export function allowedAggs(field) {
  if (!field) return ['count'];
  if (field.role !== ROLE.MEASURE) return ['count'];
  if (field.additivity === 'ratio') return ['ratio'];
  if (field.additivity === 'semi') return ['avg', 'min', 'max', 'count'];
  return ['sum', 'avg', 'min', 'max', 'count'];
}

function markUnavailable(markId, { dim, series, groupCount, geo }) {
  if (markId === 'kpi') return dim ? 'A single number has no breakdown' : null;
  if (markId === 'map') return geo ? null : 'Needs a column of places';
  if (markId === 'heatmap' && !series) return 'Needs a second breakdown';
  if (markId === 'pie' && !dim) return 'Needs a breakdown';
  if (markId === 'pie' && groupCount > 8) return `Too many slices (${groupCount})`;
  if (!dim && markId !== 'kpi') return 'Needs a breakdown, or use Number';
  return null;
}

export function specFromState(state) {
  const groupBy = [];
  if (state.dim) groupBy.push(state.grain ? { field: state.dim, grain: state.grain } : { field: state.dim });
  if (state.series) groupBy.push({ field: state.series });

  const label = state.agg === 'ratio' ? state.measure : `${state.agg.toUpperCase()} of ${state.measure}`;
  const autoTitle = state.mark === 'kpi' ? label : `${label}${state.dim ? ` by ${state.dim}` : ''}`;
  return {
    mark: state.mark,
    metrics: [{ field: state.measure, agg: state.agg }],
    groupBy,
    filters: state.filters ?? [],
    compare: state.compare ?? false,
    limit: state.limit ?? 20,
    title: state.title ?? autoTitle,
  };
}

/**
 * Mount the side panel.
 *
 * @param {App} app
 * @param {object} opts
 * @param {object} [opts.chart]   an existing chart to edit, else a new one
 * @param {(spec:object)=>void} opts.onCommit
 * @param {()=>void} opts.onClose
 */
export function chartPanel(app, { chart, onCommit, onClose } = {}) {
  const model = app.model;
  const editing = Boolean(chart);
  const measures = model.measures();
  const dims = model.dimensions().filter((d) => !d.identifierLike);

  const state = {
    measure: chart?.spec.metrics?.[0]?.field ?? measures[0]?.name ?? null,
    agg: chart?.spec.metrics?.[0]?.agg ?? null,
    dim: chart?.spec.groupBy?.[0]?.field ?? null,
    grain: chart?.spec.groupBy?.[0]?.grain ?? null,
    series: chart?.spec.groupBy?.[1]?.field ?? null,
    mark: chart?.spec.mark ?? 'bar',
    filters: chart?.spec.filters ?? [],
    limit: chart?.spec.limit ?? 20,
    compare: chart?.spec.compare ?? false,
    title: chart?.spec.title ?? null,
  };

  if (!state.dim && !editing) {
    state.dim = dims.find((d) => d.role !== ROLE.TIME && d.distinctCount >= 2 && d.distinctCount <= 12)?.name ?? dims[0]?.name ?? null;
  }
  if (state.dim && model.field(state.dim)?.role === ROLE.TIME && !state.grain) state.grain = 'quarter';
  if (!state.agg) state.agg = allowedAggs(model.field(state.measure))[0];

  const root = el('div', { className: 'panel' });
  const body = el('div', { className: 'panel-body' });
  const preview = el('div', { className: 'panel-preview' });

  const head = el('div', { className: 'panel-head' }, [el('h2', { textContent: editing ? 'Edit chart' : 'New chart' })]);
  const close = el('button', { className: 'panel-close', textContent: '×', title: 'Close' });
  close.onclick = onClose;
  head.append(close);
  root.append(head, body);

  const row = (label, control, hint) => {
    const wrap = el('div', { className: 'panel-row' });
    wrap.append(el('label', { textContent: label }), control);
    if (hint) wrap.append(el('span', { className: 'panel-hint', textContent: hint }));
    return wrap;
  };

  const select = (options, value, onChange, { allowNone, noneLabel = 'None' } = {}) => {
    const s = el('select');
    if (allowNone) s.append(el('option', { value: '', textContent: noneLabel }));
    for (const o of options) s.append(el('option', { value: o.value ?? o, textContent: o.label ?? o }));
    s.value = value ?? '';
    s.onchange = () => onChange(s.value || null);
    return s;
  };

  let groupCount = 0;

  // Counting groups is cheap and the mark picker needs it before anything is
  // drawn, so it does not wait on the preview.
  function countGroups() {
    try {
      groupCount = app.evaluate({ ...specFromState(state), limit: 1000 }).totalGroups;
    } catch {
      groupCount = 0;
    }
    return groupCount;
  }

  function drawPreview() {
    preview.replaceChildren();
    if (state.mark === 'kpi') {
      preview.append(renderKPI(app, { spec: specFromState(state) }));
      return;
    }
    try {
      const spec = specFromState(state);
      const result = app.evaluate(spec);
      groupCount = result.totalGroups;
      const vl = toVegaLite(model, { spec }, result);
      // 'container' width needs a laid-out parent; inside a panel that is still
      // being built there is none yet, so give the preview a real number.
      const avail = preview.clientWidth || 340;
      vl.width = Math.max(200, avail - 20);
      vl.height = 190;
      vl.autosize = { type: 'fit', contains: 'padding' };
      vegaEmbed(preview, vl, { actions: false, renderer: 'svg' }).catch(() => {
        preview.textContent = 'Nothing to preview yet.';
      });
    } catch (e) {
      groupCount = 0;
      preview.append(el('p', { className: 'panel-error', textContent: e.message }));
    }
  }

  function render() {
    body.replaceChildren();

    const measureField = model.field(state.measure);
    const aggs = allowedAggs(measureField);
    if (!aggs.includes(state.agg)) state.agg = aggs[0];

    body.append(
      row(
        'Measure',
        el('div', { className: 'panel-pair' }, [
          select(measures.map((m) => ({ value: m.name, label: m.name })), state.measure, (v) => {
            state.measure = v;
            state.title = null; // let the title follow the content until edited
            render();
          }),
          select(aggs.map((a) => ({ value: a, label: a.toUpperCase() })), state.agg, (v) => {
            state.agg = v;
            state.title = null;
            render();
          }),
        ]),
        aggHint(measureField)
      )
    );

    const dimField = model.field(state.dim);
    const breakdown = el('div', { className: 'panel-pair' }, [
      select(
        dims.map((d) => ({ value: d.name, label: d.name })),
        state.dim,
        (v) => {
          state.dim = v;
          state.grain = model.field(v)?.role === ROLE.TIME ? state.grain ?? 'quarter' : null;
          state.title = null;
          render();
        },
        { allowNone: true, noneLabel: 'No breakdown (total)' }
      ),
    ]);
    if (dimField?.role === ROLE.TIME) {
      breakdown.append(
        select(dimField.grains.map((g) => ({ value: g, label: `by ${g}` })), state.grain, (v) => {
          state.grain = v;
          render();
        })
      );
    }
    if (state.mark === 'kpi') {
      const cmp = el('label', { className: 'panel-check' });
      const box = el('input', { type: 'checkbox', checked: Boolean(state.compare) });
      box.onchange = () => {
        state.compare = box.checked;
        render();
      };
      cmp.append(box, 'Compare with the previous period');
      body.append(row('Comparison', cmp));
    } else {
      body.append(row('Break down by', breakdown));
    }

    if (state.mark !== 'kpi' && state.mark !== 'map') body.append(
      row(
        'Split by',
        select(
          dims.filter((d) => d.name !== state.dim && d.distinctCount <= 12).map((d) => ({ value: d.name, label: d.name })),
          state.series,
          (v) => {
            state.series = v;
            render();
          },
          { allowNone: true, noneLabel: 'Nothing' }
        )
      )
    );

    countGroups();
    const geo = state.dim ? detectGeo(model, state.dim) : null;
    const marks = el('div', { className: 'mark-picker' });
    for (const m of MARKS) {
      const why = markUnavailable(m.id, { dim: state.dim, series: state.series, groupCount, geo });
      const btn = el('button', { className: `mark${state.mark === m.id ? ' on' : ''}`, title: why ?? m.label, disabled: Boolean(why) });
      btn.append(el('span', { className: 'glyph', textContent: m.glyph }), m.label);
      btn.onclick = () => {
        state.mark = m.id;
        // The controls and the mark must never contradict each other.
        if (m.id === 'kpi') {
          state.dim = null;
          state.grain = null;
          state.series = null;
        } else if (!state.dim) {
          state.dim = dims.find((d) => d.role !== ROLE.TIME && d.distinctCount >= 2 && d.distinctCount <= 12)?.name ?? dims[0]?.name ?? null;
        }
        state.title = null;
        render();
      };
      marks.append(btn);
    }
    if (markUnavailable(state.mark, { dim: state.dim, series: state.series, groupCount, geo })) {
      state.mark = state.dim ? 'bar' : 'kpi';
    }
    body.append(row('Chart type', marks));

    // Filters that apply to this chart alone, on top of the dashboard's.
    body.append(
      row(
        'Filters on this chart',
        filterEditor(app, {
          filters: state.filters,
          scope: 'chart',
          onChange: (next) => {
            state.filters = next;
            render();
          },
        }),
        app.globalFilters.length ? `Plus the dashboard filter: ${app.globalFilters.map(describeFilter).join(', ')}` : ''
      )
    );

    // Title, editable, defaulting to a description of the content.
    const titleInput = el('input', { type: 'text', value: specFromState(state).title, placeholder: 'Chart title' });
    titleInput.oninput = () => {
      state.title = titleInput.value || null;
    };
    body.append(row('Title', titleInput));

    body.append(el('div', { className: 'panel-label', textContent: 'Preview' }), preview);
    // Wait for layout: the preview needs to be measurable before Vega sizes to it.
    requestAnimationFrame(drawPreview);

    const commit = el('button', { className: 'primary panel-commit', textContent: editing ? 'Save changes' : 'Add to dashboard' });
    commit.onclick = () => onCommit(specFromState(state));
    body.append(el('div', { className: 'panel-actions' }, [commit, el('span', { className: 'panel-hint', textContent: `${groupCount} group${groupCount === 1 ? '' : 's'}` })]));
  }

  render();
  return root;
}

function aggHint(field) {
  if (!field) return '';
  if (field.additivity === 'ratio') return `${field.expression} — recomputed at every level`;
  if (field.additivity === 'semi') return 'a rate: summing it would mean nothing';
  return '';
}
