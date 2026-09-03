// The human half of the interface.
//
// One toolbar, one way to make a chart, one dashboard. Everything here operates
// the same App state the WebMCP tools operate: a filter set with the mouse is a
// filter the agent reads back through describe_dataset, and a chart the agent
// draws is a chart the analyst can drag, edit, pin or drill.

import { toVegaLite } from '../core/vega.js';
import { ROLE } from '../core/model.js';
import { chartPanel } from './panel.js';
import { renderKPI } from './kpi.js';
import { filterEditor, describeFilter } from './filters.js';
import { detectGeo } from '../core/geo.js';
import { CANVAS_PRESETS, GRID, snap, clampToCanvas, autoArrange, minimumFor } from './layout.js';
import { PRESETS, FONTS, applyTheme } from '../core/theme.js';
import { setChartTheme } from '../core/vega.js';
import { exportPNG, exportDashboard, exportBoardImage, captureAnimation, downloadCapture } from './export.js';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) node.append(c);
  return node;
};

const isDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export function mountUI(app) {
  const toolbar = $('#toolbar');
  const canvas = $('#canvas');
  const panelSlot = $('#panel');
  const toolList = $('#tool-list');
  const logList = $('#log');
  const fieldList = $('#fields');
  const status = $('#mcp-status');

  // panel is either null, {mode:'new'} or {mode:'edit', chartId}
  let panel = null;
  let dragId = null;
  // True while a pointer drag is in flight, so the live box updates do not
  // trigger a full re-render on every mouse move.
  let dragging = false;

  // ---- WebMCP availability ------------------------------------------------
  if (app.registry.supported) {
    status.className = 'status on';
    status.textContent = 'WebMCP is available. An agent can build on this dashboard alongside you.';
  } else {
    status.className = 'status off';
    status.innerHTML =
      'No agent connected, so the dashboard is yours alone. Everything works by hand. To add an agent, ' +
      'open in ChatGPT’s browser or Chrome 149+ with <code>chrome://flags/#enable-webmcp-testing</code> enabled.';
  }

  // ---- file loading -------------------------------------------------------
  const readFile = async (file) => {
    if (!file) return;
    try {
      app.loadFromText(await file.text(), file.name.replace(/\.csv$/i, ''));
      panel = null;
    } catch (e) {
      alert(`Could not read that file: ${e.message}`);
    }
  };

  const pickFile = () => {
    const input = el('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
    input.onchange = () => readFile(input.files[0]);
    document.body.append(input);
    input.click();
    setTimeout(() => input.remove(), 1000);
  };

  document.addEventListener('dragover', (e) => {
    if (dragId) return; // reordering a card, not importing a file
    e.preventDefault();
    $('.empty')?.classList.add('drag');
  });
  document.addEventListener('dragleave', () => $('.empty')?.classList.remove('drag'));
  document.addEventListener('drop', (e) => {
    if (dragId) return;
    e.preventDefault();
    $('.empty')?.classList.remove('drag');
    readFile(e.dataTransfer?.files?.[0]);
  });

  // ---- toolbar ------------------------------------------------------------
  // One row, read left to right: what is loaded, what is filtered, what you can
  // add, and how to get the result out.

  function renderToolbar() {
    toolbar.replaceChildren();
    if (!app.model) {
      toolbar.hidden = true;
      return;
    }
    toolbar.hidden = false;

    // Row one: what is loaded, what shape the board is, and what you can do.
    const top = el('div', { className: 'tb-row' });

    const file = el('div', { className: 'tb-dataset' });
    file.append(
      el('span', { className: 'tb-name', textContent: app.model.name }),
      el('span', { className: 'tb-rows', textContent: `${app.model.rowCount.toLocaleString('en-US')} rows` })
    );
    const swap = el('button', { className: 'tb-quiet', textContent: 'Change', title: 'Load a different CSV' });
    swap.onclick = pickFile;
    file.append(swap);
    top.append(file);

    top.append(el('div', { className: 'tb-sep' }));

    // The canvas shape, in the open rather than buried in an export menu.
    const sizeWrap = el('div', { className: 'tb-size' });
    sizeWrap.append(el('span', { className: 'tb-label', textContent: 'Canvas' }));
    const sizeSel = el('select', { className: 'tb-select', title: 'The size the dashboard is designed and exported at' });
    for (const preset of CANVAS_PRESETS) {
      sizeSel.append(el('option', { value: preset.id, textContent: preset.label }));
    }
    sizeSel.value = app.canvas.id;
    sizeSel.onchange = () => {
      const preset = CANVAS_PRESETS.find((x) => x.id === sizeSel.value);
      if (preset) app.setCanvasSize(preset);
    };
    sizeWrap.append(sizeSel);
    top.append(sizeWrap);

    const actions = el('div', { className: 'tb-actions' });

    const add = el('button', { className: 'primary', textContent: '+ New chart' });
    add.onclick = () => {
      panel = { mode: 'new' };
      renderPanel();
    };
    actions.append(add);

    if (app.charts.length) {
      actions.append(
        menuButton('Export', [
          { label: 'Interactive dashboard (.html)', fn: () => doExport('dashboard') },
          { label: `Image — ${app.canvas.width} × ${app.canvas.height}`, fn: () => doExport('image') },
          { label: 'divider' },
          { label: 'Video of it drawing (.webm)', fn: () => record('webm') },
          { label: 'Animated GIF (slow)', fn: () => confirmGif() },
        ])
      );

      const tidy = el('button', { className: 'tb-quiet', textContent: 'Tidy up', title: 'Arrange every card on a clean grid' });
      tidy.onclick = () => {
        autoArrange(app.charts, app.canvas);
        app.log('human', 'Tidied the layout');
        app.emit('charts');
      };
      actions.append(tidy);

      const clear = el('button', { className: 'tb-quiet', textContent: 'Clear all', title: 'Remove every chart' });
      clear.onclick = () => {
        const pinned = app.charts.filter((c) => c.pinned).length;
        const msg = pinned
          ? `Remove all ${app.charts.length} charts, including ${pinned} pinned?`
          : `Remove all ${app.charts.length} charts?`;
        if (confirm(msg)) {
          app.clearCharts('human');
          panel = null;
          renderPanel();
        }
      };
      actions.append(clear);
    }

    top.append(actions);
    toolbar.append(top);

    // Row two: the context bar. Everything that narrows or restyles what you
    // are looking at, in one place, at a size you can actually read.
    const context = el('div', { className: 'tb-row context-bar' });

    const filterGroup = el('div', { className: 'ctx-group' });
    filterGroup.append(el('span', { className: 'ctx-label', textContent: 'Filters' }));
    filterGroup.append(
      filterEditor(app, {
        filters: app.globalFilters,
        scope: 'dashboard',
        onChange: (next) => app.setGlobalFilters(next, 'human'),
      })
    );
    context.append(filterGroup);

    // Drill-downs used to be announced in 10px text at the foot of a card,
    // which is nowhere. They belong here, beside the filters, because that is
    // what they are: a narrowing of what you are looking at.
    const drilled = app.charts.filter((c) => c.drillPath?.length);
    if (drilled.length) {
      const drillGroup = el('div', { className: 'ctx-group ctx-drill' });
      drillGroup.append(el('span', { className: 'ctx-label', textContent: 'Drilled into' }));

      for (const chart of drilled) {
        const trail = el('button', { className: 'drill-chip', title: 'Show this card' });
        trail.append(
          el('span', { className: 'drill-steps', textContent: chart.drillPath.join(' › ') }),
          el('span', { className: 'drill-of', textContent: chart.spec.title ?? '' })
        );
        trail.onclick = () => {
          const node = canvas.querySelector(`[data-id="${chart.id}"]`);
          node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          node?.classList.add('flash');
          setTimeout(() => node?.classList.remove('flash'), 1200);
        };

        const exit = el('button', { className: 'drill-exit', textContent: '×', title: 'Close this drill-down' });
        exit.onclick = () => app.removeChart(chart.id);

        const wrap = el('span', { className: 'drill-wrap' }, [trail, exit]);
        drillGroup.append(wrap);
      }

      if (drilled.length > 1) {
        const all = el('button', { className: 'ctx-quiet', textContent: `Close all ${drilled.length}` });
        all.onclick = () => {
          for (const c of drilled) app.removeChart(c.id);
        };
        drillGroup.append(all);
      }
      context.append(drillGroup);
    }

    // Style, on the right: three colours and a typeface.
    const styleGroup = el('div', { className: 'ctx-group ctx-style' });
    styleGroup.append(el('span', { className: 'ctx-label', textContent: 'Style' }));

    const swatch = (key, label) => {
      const wrap = el('label', { className: 'swatch', title: label });
      const input = el('input', { type: 'color', value: app.theme[key] });
      input.oninput = () => app.setTheme({ [key]: input.value }, 'human');
      wrap.append(input, el('span', { className: 'swatch-label', textContent: label }));
      return wrap;
    };

    styleGroup.append(swatch('accent', 'Accent'), swatch('negative', 'Losses'), swatch('paper', 'Paper'));

    const fontSel = el('select', { className: 'tb-select', title: 'Typeface' });
    for (const [key, f] of Object.entries(FONTS)) fontSel.append(el('option', { value: key, textContent: f.label }));
    fontSel.value = app.theme.font;
    fontSel.onchange = () => app.setTheme({ font: fontSel.value }, 'human');
    styleGroup.append(fontSel);

    const presetSel = el('select', { className: 'tb-select', title: 'Ready-made palettes' });
    presetSel.append(el('option', { value: '', textContent: 'Palette…' }));
    for (const [key, p] of Object.entries(PRESETS)) presetSel.append(el('option', { value: key, textContent: p.label }));
    presetSel.onchange = () => {
      if (presetSel.value) app.applyPreset(presetSel.value, 'human');
    };
    styleGroup.append(presetSel);

    if (app.themeWarning) {
      styleGroup.append(el('span', { className: 'ctx-warn', textContent: app.themeWarning, title: app.themeWarning }));
    }

    context.append(styleGroup);
    toolbar.append(context);
  }

  // A small dropdown, because a row of eight buttons is its own kind of clutter.
  function menuButton(label, items) {
    const wrap = el('div', { className: 'tb-menu' });
    const btn = el('button', { textContent: `${label} ▾` });
    const list = el('div', { className: 'tb-menu-list', hidden: true });

    for (const item of items) {
      if (item.label === 'divider') {
        list.append(el('div', { className: 'tb-menu-div' }));
        continue;
      }
      const b = el('button', { textContent: item.label });
      b.onclick = () => {
        list.hidden = true;
        item.fn();
      };
      list.append(b);
    }

    btn.onclick = (e) => {
      e.stopPropagation();
      list.hidden = !list.hidden;
    };
    document.addEventListener('click', () => (list.hidden = true));

    wrap.append(btn, list);
    return wrap;
  }

  async function doExport(kind, arg) {
    try {
      if (kind === 'dashboard') {
        const n = exportDashboard(app);
        app.log('human', `Exported an interactive dashboard with ${n} chart(s)`);
      } else if (kind === 'image') {
        const { width, height } = await exportBoardImage(app);
        app.log('human', `Exported the dashboard as ${width}×${height}`);
      }
    } catch (e) {
      alert(e.message);
    }
  }

  function confirmGif() {
    const n = app.charts.length;
    if (confirm(`Encoding a GIF of ${n} chart${n === 1 ? '' : 's'} runs here in the browser and can take several minutes. The video is far faster and sharper. Carry on with the GIF?`)) {
      record('gif');
    }
  }

  async function record(format) {
    const note = el('div', { className: 'recording' }, ['Recording… 0%']);
    document.body.append(note);
    try {
      const out = await captureAnimation(app, {
        format,
        onProgress: (p) => (note.textContent = `Recording… ${Math.round(p * 100)}%`),
      });
      const mb = out.blob.size / 1_048_576;
      downloadCapture(out, app.model.name);
      app.log('human', `Recorded ${format.toUpperCase()} (${mb.toFixed(1)} MB)`);
    } catch (e) {
      alert(e.message);
    } finally {
      note.remove();
    }
  }

  // ---- the panel ----------------------------------------------------------

  function renderPanel() {
    panelSlot.replaceChildren();
    document.body.classList.toggle('panel-open', Boolean(panel));
    if (!panel || !app.model) return;

    const chart = panel.mode === 'edit' ? app.getChart(panel.chartId) : null;
    if (panel.mode === 'edit' && !chart) {
      panel = null;
      return;
    }

    panelSlot.append(
      chartPanel(app, {
        chart,
        onCommit: (spec) => {
          if (chart) app.updateChart(chart.id, spec);
          else app.addChart(spec, { author: 'human' });
          panel = null;
          renderPanel();
        },
        onClose: () => {
          panel = null;
          renderPanel();
        },
      })
    );
  }

  // ---- canvas -------------------------------------------------------------

  // Screen pixels per canvas pixel. The canvas is a fixed shape; the window is
  // not, so the whole board is scaled to fit and every coordinate stays in
  // canvas units.
  let scale = 1;

  function computeScale() {
    const wrap = canvas.parentElement;
    // clientWidth includes padding, so subtract it rather than guessing.
    const style = getComputedStyle(wrap);
    const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const available = wrap.clientWidth - pad;
    scale = available > 0 ? Math.min(1, available / app.canvas.width) : 1;
    return scale;
  }

  // Re-fit when the window changes, without redrawing every chart: only the
  // stage transform and the wrapper height depend on the width.
  function refit() {
    if (!canvas.classList.contains('stage')) return;
    computeScale();
    canvas.style.transform = `scale(${scale})`;
    canvas.parentElement.style.height = `${app.canvas.height * scale + 24}px`;
  }

  function renderCanvas() {
    canvas.replaceChildren();
    canvas.classList.toggle('has-model', Boolean(app.model));

    if (!app.model || !app.charts.length) {
      canvas.style.width = '';
      canvas.style.height = '';
      canvas.classList.remove('stage');
      canvas.append(emptyState());
      return;
    }

    computeScale();
    canvas.classList.add('stage');
    // The stage is drawn at true canvas size and scaled down as a whole, so
    // what you arrange is exactly what exports.
    canvas.style.width = `${app.canvas.width}px`;
    canvas.style.height = `${app.canvas.height}px`;
    canvas.style.transform = `scale(${scale})`;
    canvas.parentElement.style.height = `${app.canvas.height * scale + 24}px`;

    for (const chart of app.charts) canvas.append(renderCard(chart));
  }

  // Dragging and resizing, in canvas units. Pointer events cover mouse, trackpad
  // and touch with one code path.
  function attachDragResize(card, chart) {
    const onPointerDown = (e, mode) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      dragging = true;
      card.classList.add('manipulating');
      // Capture on the element the event actually started on; capturing on an
      // ancestor throws InvalidStateError and kills the whole interaction.
      // currentTarget is nulled once the event finishes dispatching, so keep a
      // reference for the release.
      const handle = e.currentTarget;
      handle.setPointerCapture?.(e.pointerId);

      const startX = e.clientX;
      const startY = e.clientY;
      const start = { ...chart.box };

      const onMove = (ev) => {
        const dx = (ev.clientX - startX) / scale;
        const dy = (ev.clientY - startY) / scale;

        let next;
        if (mode === 'move') {
          next = { ...start, x: snap(start.x + dx), y: snap(start.y + dy) };
        } else {
          const min = minimumFor(chart.spec.mark);
          next = {
            ...start,
            width: Math.max(min.w, snap(start.width + dx)),
            height: Math.max(min.h, snap(start.height + dy)),
          };
          // Say why it stopped, rather than just refusing to move.
          card.classList.toggle('at-minimum', next.width === min.w || next.height === min.h);
        }
        next = clampToCanvas(next, app.canvas, chart.spec.mark);
        chart.box = next;
        applyBox(card, next);
      };

      const onUp = (ev) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        handle.releasePointerCapture?.(ev.pointerId);
        dragging = false;
        card.classList.remove('manipulating', 'at-minimum');
        // Commit once, at the end: a redraw per pixel would re-render Vega
        // hundreds of times, and re-rendering mid-drag would destroy the node
        // being dragged.
        app.setChartBox(chart.id, chart.box);
        if (mode === 'resize') redrawChart(card, chart);
        raise(card);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    card.querySelector('.card-grip').addEventListener('pointerdown', (e) => onPointerDown(e, 'move'));
    card.querySelector('.card-resize').addEventListener('pointerdown', (e) => onPointerDown(e, 'resize'));
  }

  // Stacking order without a re-render: move the node to the end and record it.
  function raise(card) {
    const id = card.dataset.id;
    const chart = app.getChart(id);
    if (!chart) return;
    const idx = app.charts.indexOf(chart);
    if (idx === app.charts.length - 1) return;
    app.charts.splice(idx, 1);
    app.charts.push(chart);
    canvas.append(card);
  }

  function applyBox(card, box) {
    card.style.left = `${box.x}px`;
    card.style.top = `${box.y}px`;
    card.style.width = `${box.width}px`;
    card.style.height = `${box.height}px`;
  }

  // Redraw just this card's visualisation, at its new size.
  function redrawChart(card, chart) {
    const holder = card.querySelector('.chart');
    if (!holder) return;
    holder.replaceChildren();
    drawInto(holder, chart, card);
  }

  function drawInto(holder, chart, card) {
    if (chart.spec.mark === 'kpi') {
      holder.classList.add('chart-kpi');
      holder.append(renderKPI(app, chart, { height: chart.box.height }));
      return;
    }

    try {
      const result = app.evaluate(chart.spec);
      const spec = toVegaLite(app.model, chart, result);
      spec.width = Math.max(160, chart.box.width - 34);
      spec.height = chartHeightFor(card, chart);
      // 'fit' makes Vega treat width/height as the OUTER size and shrink the
      // plot to fit its axes inside. 'fit-x' does that horizontally only, so
      // the height we pass is the plotting area and the axis furniture is added
      // below it — which is what `settle` then measures and reclaims.
      spec.autosize = { type: 'fit-x', contains: 'padding' };

      // With autosize 'fit', Vega treats `height` as the plotting area and adds
      // axis furniture around it, so the rendered SVG can come back taller than
      // asked and escape the card, taking its x-axis with it. The overshoot
      // depends on the axis labels and cannot be known in advance, so measure it
      // once the chart exists and give the difference back. One correction
      // converges: the second render's furniture is the same size.
      // The correction is symmetric: an SVG that came back short leaves a band
      // of dead space under the chart, which looks like a bug and wastes the
      // card. Same measurement, either sign.
      //
      // Measure both sides in the SAME space. The canvas is transform-scaled,
      // so getBoundingClientRect() returns scaled pixels while clientHeight
      // returns unscaled ones. Comparing one against the other applied the
      // scale twice and left the chart permanently short of its card.
      // Fit the plot to the space the card actually gives it, in both
      // directions: an SVG that overshoots spills its axis out of the card, and
      // one that comes up short leaves a dead band under the chart.
      //
      // Everything is measured in the SVG's own units. `height` attribute and
      // `view.height()` are both unscaled, so their difference is the axis
      // furniture Vega added, and the holder's rect is converted into the same
      // space through the stage scale. Mixing clientHeight (unscaled) with a
      // bounding rect (scaled) applied the transform twice, which is what left
      // every chart short of its card.
      const settle = async (view, pass = 0) => {
        const svg = holder.querySelector('svg');
        if (!svg) return;
        const availPx = holder.getBoundingClientRect().height;
        if (availPx < 20) return;
        const avail = availPx / (scale || 1); // unscaled units
        const drawn = Number(svg.getAttribute('height')); // already unscaled
        if (!drawn) return;
        // `drawn` is the plotting area plus the axis furniture Vega put around
        // it. Reserve that furniture and solve for the plot height that makes
        // the whole SVG match the space the card actually offers. Computing it
        // from `drawn` each pass — rather than adjusting the previous value by
        // a delta — is what keeps this from converging on a too-short chart.
        const furniture = Math.max(0, drawn - view.height());
        const target = Math.max(40, Math.round(avail - furniture - 2));
        if (Math.abs(target - view.height()) <= 2) return;
        await view.height(target).runAsync();
        // Resizing can change the furniture (rotated labels, a wrapped legend),
        // so measure once more. Two passes converge; a loop would fight the
        // renderer.
        if (pass < 1) await settle(view, pass + 1);
      };

      vegaEmbed(holder, spec, { actions: false, renderer: 'svg' })
        .then((res) => {
          holder.__vegaView = res.view;
          attachDrill(res.view, chart, holder);
          requestAnimationFrame(() => settle(res.view));
        })
        .catch((e) => {
          holder.textContent = `Could not draw this chart: ${e.message}`;
        });
    } catch (e) {
      holder.textContent = `This chart cannot be drawn: ${e.message}`;
    }
  }

  // Room the card's own furniture takes, measured rather than guessed. A fixed
  // estimate drifts every time the header gains a control, and the chart then
  // renders taller than the space left for it and spills out of the card.
  function chartHeightFor(card, chart) {
    const scaleNow = scale || 1;
    // Measure the siblings the chart shares the card with. The .chart element
    // itself is flex:1 and has no height yet at this point, so asking it would
    // return zero and the chart would be sized against nothing.
    //
    // chart.box.height is in unscaled canvas units, so the siblings measured
    // off the scaled DOM have to be divided back into the same space before
    // they can be subtracted from it.
    let used = 24; // card padding, top and bottom
    for (const node of card.children) {
      if (node.classList.contains('chart')) continue;
      used += node.getBoundingClientRect().height / scaleNow;
    }
    return Math.max(90, Math.floor(chart.box.height - used));
  }

  function renderCard(chart) {
    const card = el('div', { className: `card${chart.pinned ? ' pinned' : ''}` });
    card.dataset.id = chart.id;
    if (!chart.box) chart.box = { x: 0, y: 0, width: 420, height: 320 };
    applyBox(card, chart.box);

    // The header is the drag handle, and it carries a visible grip: a 21px band
    // on a canvas scaled to 65% is a 14px target, which nobody can hit on
    // purpose. The dots say "grab here" and give the pointer somewhere to land.
    const header = el('header', { className: 'card-grip', title: 'Drag to move' });
    const dots = el('span', { className: 'grip-dots', ariaHidden: 'true' });
    const title = el('h3', { textContent: chart.spec.title ?? 'Untitled chart' });
    const actions = el('div', { className: 'actions' });

    // Icon-only controls at 12px were a guessing game. Each one now carries its
    // name, and the destructive one is separated from the rest.
    const mkBtn = (glyph, label, fn, extraClass = '') => {
      const b = el('button', { className: `card-btn ${extraClass}`.trim(), title: label });
      b.append(el('span', { className: 'card-btn-glyph', textContent: glyph }), el('span', { className: 'card-btn-label', textContent: label }));
      // The header drags; its buttons must not.
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.onclick = fn;
      return b;
    };

    actions.append(
      mkBtn('⚙', 'Edit', () => {
        panel = { mode: 'edit', chartId: chart.id };
        renderPanel();
      }),
      mkBtn('⇩', 'PNG', async () => {
        try {
          await exportPNG(card, chart);
          app.log('human', `Downloaded ${chart.id} as PNG`);
        } catch (e) {
          alert(e.message);
        }
      }),
      mkBtn('✎', 'Note', () => {
        const text = prompt('Note for this chart:');
        if (text) app.annotate(chart.id, text, 'human');
      }),
      mkBtn(chart.pinned ? '◉' : '○', chart.pinned ? 'Pinned' : 'Pin', () => app.togglePin(chart.id), chart.pinned ? 'on' : ''),
      mkBtn('×', 'Remove', () => app.removeChart(chart.id), 'danger')
    );

    header.append(dots, title, actions);
    card.append(header);

    const m = chart.spec.metrics.map((x) => (x.agg === 'ratio' ? x.field : `${x.agg.toUpperCase()} of ${x.field}`)).join(', ');
    const g = chart.spec.groupBy?.map((x) => x.field + (x.grain ? ` by ${x.grain}` : '')).join(' × ');
    const meta = el('div', { className: 'meta' });
    meta.append(el('span', { className: 'meta-spec', textContent: g ? `${m} by ${g}` : m }));
    card.append(meta);

    // Filters for this card alone, editable in place. Opening a side panel to
    // narrow one chart was more ceremony than the action deserves.
    const cardFilters = el('div', { className: 'card-filters' });
    cardFilters.append(
      filterEditor(app, {
        filters: chart.spec.filters ?? [],
        scope: 'chart',
        compact: true,
        onChange: (next) => app.updateChart(chart.id, { filters: next }),
      })
    );
    cardFilters.addEventListener('pointerdown', (e) => e.stopPropagation());
    card.append(cardFilters);

    const holder = el('div', { className: 'chart' });
    card.append(holder);
    drawInto(holder, chart, card);

    if (chart.drillPath?.length) {
      const path = el('div', { className: 'drill-path' });
      const back = el('button', { className: 'crumb-back', textContent: '↰ remove', title: 'Remove this drill-down' });
      back.addEventListener('pointerdown', (e) => e.stopPropagation());
      back.onclick = () => app.removeChart(chart.id);
      path.append(`↳ ${chart.drillPath.join('  ›  ')}  `, back);
      card.append(path);
    }

    for (const n of chart.notes ?? []) {
      const note = el('div', { className: 'note' });
      note.append(el('b', { textContent: n.author === 'agent' ? 'Agent' : 'You' }), ` · ${n.text}`);
      card.append(note);
    }

    // The resize grip, bottom right.
    const grip = el('div', { className: 'card-resize', title: 'Drag to resize' });
    card.append(grip);

    attachDragResize(card, chart);
    return card;
  }

  // Clicking a bar drills, exactly as the agent's drill_down tool does.
  function attachDrill(view, chart, holder) {
    const parentDim = chart.spec.groupBy?.[0]?.field;
    if (!parentDim) return;
    const parent = app.model.field(parentDim);
    if (!parent || parent.role === ROLE.TIME) return;

    const target = app.model
      .dimensions()
      .find((d) => d.name !== parentDim && !d.identifierLike && d.role !== ROLE.TIME && d.distinctCount >= 2 && d.distinctCount <= 30);
    if (!target) return;

    // Say it is clickable before it is clicked.
    holder.classList.add('drillable');
    holder.title = `Click to break a ${parentDim} down by ${target.name}`;

    view.addEventListener('click', (evt, item) => {
      let value = item?.datum?.[parentDim];

      // A choropleth is two layers, and the click may land on the grey outline
      // underneath, whose datum carries nothing. Fall back to hit-testing the
      // data layer for the shape under the pointer.
      if (value == null && chart.spec.mark === 'map') {
        value = geoValueAt(view, evt, item, parentDim);
      }
      if (value == null) return;
      // Drilling changes what the chart is grouped by, and the mark has to
      // follow. A map of States broken down by Sub-Category is not a map, and
      // inheriting 'map' produced a card that could only say so.
      const mark = markForDrill(chart.spec.mark, target.name);

      app.addChart(
        {
          ...chart.spec,
          mark,
          groupBy: [{ field: target.name }],
          filters: [...(chart.spec.filters ?? []), { col: parentDim, op: '=', value }],
          title: `${value} by ${target.name}`,
        },
        { drilledFrom: chart.id, drillPath: [...(chart.drillPath ?? []), `${parentDim}=${value}`], author: 'human' }
      );
    });
  }

  // Find which mapped shape was clicked.
  //
  // A choropleth is two layers, and the click usually lands on the grey outline
  // beneath, whose datum is empty. Vega still reports where the pointer was, in
  // the item's own coordinate space, so the reliable move is to ask the item
  // for its position and match it against the joined layer rather than trying
  // to reconcile page coordinates with a transform-scaled stage.
  function geoValueAt(view, evt, item, parentDim) {
    try {
      // The outline layer and the data layer share a projection, so the shape
      // the user hit has the same bounds in both. Match on that.
      const bounds = item?.bounds;
      if (!bounds) return null;

      const isDataMark = (d) => d && Object.keys(d).some((k) => /^(sum|avg|min|max|count|ratio)\(/.test(k));

      let found = null;
      const walk = (node, depth = 0) => {
        if (found || !node || depth > 8) return;
        if (node.marktype === 'shape' && Array.isArray(node.items)) {
          for (const it of node.items) {
            if (!isDataMark(it.datum) || !it.bounds) continue;
            // Same shape, same place: compare the rendered rectangles.
            const near =
              Math.abs(it.bounds.x1 - bounds.x1) < 1 &&
              Math.abs(it.bounds.y1 - bounds.y1) < 1 &&
              Math.abs(it.bounds.x2 - bounds.x2) < 1;
            if (near) {
              found = it.datum.properties?.name ?? it.datum[parentDim] ?? null;
              return;
            }
          }
        }
        for (const child of node.items ?? []) walk(child, depth + 1);
      };
      walk(view.scenegraph().root);
      return found;
    } catch {
      return null;
    }
  }

  // Which mark suits the dimension we are drilling into.
  function markForDrill(currentMark, targetField) {
    if (currentMark === 'map') {
      // Stay a map only if the new dimension is itself geographic.
      return detectGeo(app.model, targetField) ? 'map' : 'bar';
    }
    if (currentMark === 'kpi') return 'bar'; // a KPI has nothing to drill from
    if (currentMark === 'heatmap') return 'bar'; // the second dimension is gone
    return currentMark;
  }

  function emptyState() {
    const box = el('div', { className: 'empty' });

    if (!app.model) {
      box.append(
        el('h2', { textContent: 'Drop a CSV to begin' }),
        el('p', {
          textContent:
            'Your file is read in this tab. It is not uploaded, and there is no server to upload it to. The page works out which columns are measures and which are dimensions, and you build a dashboard from there.',
        })
      );
      const row = el('div', { className: 'row' });
      const pick = el('button', { className: 'primary', textContent: 'Choose a file' });
      pick.onclick = pickFile;
      const sample = el('button', { textContent: 'Try the sample data' });
      sample.onclick = () => app.loadSample().catch((e) => alert(e.message));
      row.append(pick, sample);
      box.append(row);
    } else {
      // Straight after a file loads, the only question that matters is "what
      // now". Answer it with two named routes rather than a bare canvas.
      box.classList.add('onboard');
      box.append(
        el('h2', { textContent: `${app.model.name} is loaded and modelled` }),
        el('p', {
          textContent: `${app.model.rowCount.toLocaleString('en-US')} rows, ${app.model.measures().length} measures and ${app.model.dimensions().length} dimensions. Nothing was uploaded. Pick a starting point:`,
        })
      );

      const routes = el('div', { className: 'routes' });

      const build = el('button', { className: 'route' });
      build.append(
        el('span', { className: 'route-title', textContent: 'Create your first chart' }),
        el('span', { className: 'route-sub', textContent: 'Choose a measure and a breakdown, and see it before you add it.' })
      );
      build.onclick = () => {
        panel = { mode: 'new' };
        renderPanel();
      };

      const auto = el('button', { className: 'route' });
      auto.append(
        el('span', { className: 'route-title', textContent: 'Start with an example dashboard' }),
        el('span', { className: 'route-sub', textContent: 'The page picks a headline number and a few charts from your columns. Edit or remove any of them.' })
      );
      auto.onclick = () => {
        drawOverview(app);
        autoArrange(app.charts, app.canvas);
        app.emit('charts');
      };

      routes.append(build, auto);
      box.append(routes);

      if (app.registry.supported) {
        box.append(el('p', { className: 'route-agent', textContent: 'Or ask the connected agent to build it for you.' }));
      }
    }
    return box;
  }

  function renderTools() {
    toolList.replaceChildren();
    const names = app.activeTools ?? [];
    if (!names.length) {
      toolList.append(el('div', { className: 'tool', textContent: 'none registered' }));
      return;
    }
    for (const n of names) {
      const row = el('div', { className: 'tool', id: `tool-${n}` }, [n]);
      if (READ_ONLY.has(n)) row.append(el('span', { className: 'ro', textContent: 'read' }));
      toolList.append(row);
    }
  }

  function renderFields() {
    fieldList.replaceChildren();
    if (!app.model) return;
    for (const name of app.model.fieldNames()) {
      const f = app.model.field(name);
      if (f.identifierLike) continue;

      const det = el('details');
      const sum = el('summary');
      sum.append(el('span', { className: 'fname', textContent: name }));

      if (f.role === ROLE.MEASURE) {
        const cls = f.additivity === 'ratio' ? 'tag ratio' : 'tag measure';
        sum.append(el('span', { className: cls, textContent: f.additivity === 'ratio' ? 'ratio' : f.additivity === 'semi' ? 'rate' : 'sum' }));
      } else {
        sum.append(el('span', { className: 'tag', textContent: f.role === ROLE.TIME ? 'date' : 'dim' }));
      }
      if (f.calculated) sum.append(el('span', { className: 'tag calc', textContent: 'new' }));

      det.append(sum);

      const bits = [];
      if (f.expression) bits.push(f.expression);
      if (f.description) bits.push(f.description);
      if (f.role === ROLE.MEASURE && !f.calculated) bits.push(`aggregate with ${f.defaultAgg}`);
      if (f.role === ROLE.TIME && f.min) bits.push(`${f.min.toISOString().slice(0, 10)} to ${f.max.toISOString().slice(0, 10)}`);
      if (f.role === ROLE.DIMENSION) bits.push(`${f.distinctCount} distinct values`);
      det.append(el('div', { className: 'detail', textContent: bits.join('\n') }));
      fieldList.append(det);
    }
  }

  function renderLog() {
    logList.replaceChildren();
    for (const entry of app.activityLog.slice(0, 14)) {
      const li = el('li', { className: entry.actor });
      li.append(el('span', { className: 'who', textContent: entry.actor === 'agent' ? 'Agent' : 'You' }), entry.text);
      logList.append(li);
    }
  }

  // ---- wiring -------------------------------------------------------------

  const renderAll = () => {
    renderToolbar();
    renderCanvas();
    renderPanel();
    renderTools();
    renderFields();
    renderLog();
  };

  app.on((kind) => {
    if (kind === 'log') return renderLog();
    if (kind === 'tools') return renderTools();
    if (kind === 'layout') {
      // A drag moves the node itself and needs no redraw. Any other source of a
      // box change (an agent, a restored layout, a programmatic resize) has not
      // touched the DOM, so the card has to be re-laid out or its chart keeps
      // the size it was first drawn at and spills out of the card.
      if (!dragging) renderCanvas();
      return;
    }
    if (kind === 'theme') {
      // Colours live in CSS variables and in the chart palette; both have to be
      // updated before anything redraws.
      applyTheme(app.theme);
      setChartTheme(app.theme);
    }
    renderAll();
  });

  applyTheme(app.theme);
  setChartTheme(app.theme);

  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', renderCanvas);
  window.addEventListener('resize', refit);
  // The side panel opening changes the space available, and that is a layout
  // change the window resize event never fires for.
  new ResizeObserver(refit).observe(canvas.parentElement);

  renderAll();
}

// One click, a board worth looking at: a headline number, the shape over time,
// where it happens, and what is losing money.
function drawOverview(app) {
  const model = app.model;
  const measure = model.measures().find((m) => m.format === 'currency') ?? model.measures()[0];
  if (!measure) return;
  const agg = measure.defaultAgg;

  // The headline.
  app.addChart(
    { mark: 'kpi', metrics: [{ field: measure.name, agg }], groupBy: [], compare: true, title: `Total ${measure.name}` },
    { author: 'human' }
  );

  const time = model.dimensions().find((d) => d.role === ROLE.TIME);
  if (time) {
    app.addChart(
      { mark: 'line', metrics: [{ field: measure.name, agg }], groupBy: [{ field: time.name, grain: 'quarter' }], title: `${measure.name} over time` },
      { author: 'human', wide: true }
    );
  }

  // A map, but only where the data actually has places in it.
  const geoDim = model
    .dimensions()
    .find((d) => !d.identifierLike && d.role !== ROLE.TIME && detectGeo(model, d.name));
  if (geoDim) {
    app.addChart(
      { mark: 'map', metrics: [{ field: measure.name, agg }], groupBy: [{ field: geoDim.name }], limit: 300, title: `${measure.name} by ${geoDim.name}` },
      { author: 'human' }
    );
  }

  const cats = model
    .dimensions()
    .filter((d) => !d.identifierLike && d.role !== ROLE.TIME && d.name !== geoDim?.name && d.distinctCount >= 2 && d.distinctCount <= 12)
    .sort((a, b) => a.distinctCount - b.distinctCount);
  if (cats[0]) {
    app.addChart(
      { mark: 'bar', metrics: [{ field: measure.name, agg }], groupBy: [{ field: cats[0].name }], title: `${measure.name} by ${cats[0].name}` },
      { author: 'human' }
    );
  }

  // Whatever is losing money deserves its own card.
  const signed = model.measures().find((m) => m.min < 0);
  const detail = model.dimensions().find((d) => !d.identifierLike && d.role !== ROLE.TIME && d.distinctCount > 12 && d.distinctCount <= 30);
  if (signed && detail) {
    app.addChart(
      { mark: 'bar', metrics: [{ field: signed.name, agg: signed.defaultAgg }], groupBy: [{ field: detail.name }], title: `${signed.name} by ${detail.name}` },
      { author: 'human' }
    );
  }
}

const READ_ONLY = new Set(['describe_dataset', 'get_field_values', 'query_data', 'find_outliers', 'list_charts', 'get_canvas_status']);

export function flashTool(name) {
  const node = document.getElementById(`tool-${name}`);
  if (!node) return;
  node.classList.add('firing');
  setTimeout(() => node.classList.remove('firing'), 900);
}
