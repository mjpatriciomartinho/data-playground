// Getting work out of the page.
//
// Four ways out, and none of them involves a server: a transparent PNG, a
// self-contained interactive HTML dashboard, a WebM screen capture of the charts
// drawing themselves, and an animated GIF of the same. Everything is produced in
// the tab, from data that is already in the tab.

import { toVegaLite } from '../core/vega.js';
import { computeKPI, formatValue } from './kpi.js';
import { derive } from '../core/theme.js';

const download = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// Canvas 2D needs a real font stack string, not a token.
const FONT_STACK = (key) =>
  ({
    ledger: "'Iowan Old Style', Palatino, serif",
    grotesque: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    editorial: "Georgia, 'Times New Roman', serif",
    mono: "ui-monospace, Menlo, monospace",
  }[key] ?? "'Iowan Old Style', Palatino, serif");

const slug = (s) =>
  (s || 'chart')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

// ---- PNG ------------------------------------------------------------------

// Vega-embed keeps a view handle on the container; use it when it is there,
// because it renders at any scale factor with a genuinely transparent ground.
export async function exportPNG(cardEl, chart, { scale = 2, transparent = true } = {}) {
  const view = cardEl.querySelector('.chart')?.__vegaView;
  if (!view) throw new Error('This chart has not finished drawing yet.');

  const url = await view.toImageURL('png', scale);
  const res = await fetch(url);
  let blob = await res.blob();

  if (!transparent) blob = await flatten(blob);
  download(blob, `${slug(chart.spec.title)}.png`);
}

// A white ground for anywhere transparency is unwelcome, such as a slide deck
// that is not on a white background itself.
async function flatten(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// ---- interactive HTML dashboard -------------------------------------------

/**
 * Write a standalone dashboard.
 *
 * Only aggregated results travel: for each chart, the grouped table it displays,
 * plus one pre-computed breakdown per drillable dimension. The source rows are
 * never written out, so the file is safe to send to someone who is not allowed
 * to see the underlying data.
 */
export function exportDashboard(app) {
  const model = app.model;
  const p = derive(app.theme);
  const dark = p.dark;
  const charts = app.listCharts();
  if (!charts.length) throw new Error('There is nothing on the canvas to export.');

  const payload = charts.map((chart) => {
    const result = app.evaluate(chart.spec);
    const spec = toVegaLite(model, chart, result, { dark });

    // Pre-compute the next level down for every category, so the exported file
    // can drill without carrying the dataset.
    const drill = {};
    const parentDim = chart.spec.groupBy?.[0]?.field;
    const parentField = parentDim ? model.field(parentDim) : null;

    if (parentDim && parentField?.role !== 'time') {
      const targets = model
        .dimensions()
        .filter((d) => d.name !== parentDim && !d.identifierLike && d.role !== 'time' && d.distinctCount >= 2 && d.distinctCount <= 25)
        .slice(0, 3);

      for (const category of result.rows.map((r) => r[parentDim])) {
        drill[category] = {};
        for (const t of targets) {
          try {
            const sub = app.evaluate({
              ...chart.spec,
              groupBy: [{ field: t.name }],
              filters: [...(chart.spec.filters ?? []), { col: parentDim, op: '=', value: category }],
            });
            if (!sub.rows.length) continue;
            const subChart = { ...chart, spec: { ...chart.spec, groupBy: [{ field: t.name }], title: `${category} by ${t.name}` } };
            drill[category][t.name] = toVegaLite(model, subChart, sub, { dark });
          } catch {
            // A breakdown that cannot be computed is simply not offered.
          }
        }
        if (!Object.keys(drill[category]).length) delete drill[category];
      }
    }

    return {
      id: chart.id,
      title: chart.spec.title ?? 'Untitled',
      meta: describeSpec(chart.spec),
      notes: (chart.notes ?? []).map((n) => ({ author: n.author, text: n.text })),
      parentDim,
      box: chart.box ?? null,
      kind: chart.spec.mark,
      kpi: chart.spec.mark === 'kpi' ? kpiPayload(app, chart) : null,
      spec,
      drill,
    };
  });

  const html = dashboardHTML({
    name: model.name,
    rowCount: model.rowCount,
    filters: app.globalFilters,
    charts: payload,
    canvas: app.canvas,
    palette: p,
    fontStack: FONT_STACK(p.font),
    generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
  });

  download(new Blob([html], { type: 'text/html' }), `${slug(model.name)}-dashboard.html`);
  return payload.length;
}

// A KPI is HTML rather than a Vega spec, so the export carries its numbers.
function kpiPayload(app, chart) {
  try {
    const d = computeKPI(app, chart.spec);
    return {
      value: formatValue(d.value, d.field),
      negative: d.value != null && d.value < 0,
      label: chart.spec.metrics[0].agg === 'ratio' ? chart.spec.metrics[0].field : `${chart.spec.metrics[0].agg.toUpperCase()} of ${chart.spec.metrics[0].field}`,
      delta: d.delta
        ? {
            pct: `${d.delta.pct >= 0 ? '▲' : '▼'} ${Math.abs(d.delta.pct * 100).toFixed(1)}%`,
            up: d.delta.pct >= 0,
            vs: `${d.delta.currentLabel} vs ${d.delta.previousLabel}`,
            partial: d.delta.partial,
          }
        : null,
      rows: `${d.rows.toLocaleString('en-US')} rows`,
    };
  } catch {
    return null;
  }
}

function describeSpec(spec) {
  const m = spec.metrics.map((x) => `${x.agg}(${x.field})`).join(', ');
  const g = spec.groupBy?.map((x) => x.field + (x.grain ? ` / ${x.grain}` : '')).join(' × ') || 'total';
  const f = spec.filters?.length ? ` · ${spec.filters.map((x) => `${x.col} ${x.op} ${x.value}`).join(', ')}` : '';
  return `${m} by ${g}${f}`;
}

function dashboardHTML({ name, rowCount, filters, charts, canvas, palette, fontStack, generated }) {
  // The exported page is the board: same shape, same positions, same colours.
  // It is deliberately plain otherwise, because it has to open on a stranger's
  // machine years from now with nothing but Vega from a CDN.
  const p = palette;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} — dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/vega@5.30.0/build/vega.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/vega-lite@5.21.0/build/vega-lite.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/vega-embed@6.26.0/build/vega-embed.min.js"><\/script>
<style>
:root{
  --paper:${p.paper}; --card:${p.paperRaised}; --rule:${p.rule}; --rule-strong:${p.ruleStrong};
  --ink:${p.ink}; --soft:${p.inkSoft}; --faint:${p.inkFaint};
  --accent:${p.accent}; --accent-soft:${p.accentSoft}; --negative:${p.negative};
  --display:${fontStack}; --body:${fontStack};
  color-scheme:${p.dark ? 'dark' : 'light'};
}
*{box-sizing:border-box}
body{margin:0;background:${p.dark ? '#0f1113' : '#e8e9e5'};color:var(--ink);font:14px/1.5 var(--body);-webkit-font-smoothing:antialiased}
header{padding:14px 22px;display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;color:var(--soft)}
h1{font:600 19px/1.2 var(--display);margin:0;color:var(--ink)}
.sub{font-size:12px}
.stamp{margin-left:auto;font:11px ui-monospace,Menlo,monospace;opacity:.7}
.wrap{padding:0 22px 26px;overflow:auto}
.board{position:relative;transform-origin:top left;background:var(--paper);border:1px solid var(--rule-strong);border-radius:4px;box-shadow:0 2px 16px rgba(0,0,0,.12)}
.card{position:absolute;display:flex;flex-direction:column;overflow:hidden;background:var(--card);border:1px solid var(--rule);border-radius:3px;padding:12px 14px 10px}
h2{font:600 15px/1.3 var(--display);margin:0 0 2px}
.meta{font:10.5px ui-monospace,Menlo,monospace;color:var(--faint);margin-bottom:8px;word-break:break-word}
.viz{flex:1;min-height:0;width:100%}
.note{font-size:12px;line-height:1.4;border-left:2px solid var(--accent);background:var(--accent-soft);padding:5px 8px;margin-top:8px;border-radius:0 2px 2px 0}
.note b{color:var(--accent)}
.crumbs{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:6px;min-height:20px}
.crumb{font:11px ui-monospace,Menlo,monospace;color:var(--accent);background:none;border:1px solid var(--rule);border-radius:2px;padding:2px 7px;cursor:pointer}
.crumb:hover{border-color:var(--accent)}
.hint{font-size:11px;color:var(--faint)}
select{font:12px var(--body);color:var(--ink);background:var(--paper);border:1px solid var(--rule);border-radius:2px;padding:3px 6px}
.kpi{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.kpi-value{font:600 clamp(30px,6vw,58px)/1 var(--display);letter-spacing:-.02em;color:var(--accent)}
.kpi-value.neg{color:var(--negative)}
.kpi-label{font-size:12px;color:var(--soft);margin-top:7px}
.kpi-delta{display:inline-flex;gap:6px;align-items:baseline;font-size:12.5px;font-weight:600;margin-top:10px;padding:3px 9px;border-radius:11px}
.kpi-delta.up{color:var(--accent);background:var(--accent-soft)}
.kpi-delta.down,.kpi-delta.partial{color:var(--negative);background:var(--rule)}
.kpi-vs{font-weight:400;font-size:10.5px;opacity:.75}
.kpi-rows{font:10.5px ui-monospace,Menlo,monospace;color:var(--faint);margin-top:9px}
footer{padding:0 22px 30px;color:var(--faint);font-size:11.5px;max-width:70ch}
</style>
</head>
<body>
<header>
  <h1>${esc(name)}</h1>
  <span class="sub">${rowCount.toLocaleString('en-US')} rows${filters.length ? ' · ' + esc(filters.map((f) => `${f.col} ${f.op} ${f.value}`).join(', ')) : ''}</span>
  <span class="stamp">${esc(generated)}</span>
</header>
<div class="wrap"><div class="board" id="board"></div></div>
<footer>
  Exported from Data Playground. Aggregated results only, never the underlying
  rows. Click a bar to break it down; use the breadcrumb to come back.
</footer>
<script>
const CHARTS = ${JSON.stringify(charts)};
const CANVAS = ${JSON.stringify(canvas)};

const board = document.getElementById('board');
board.style.width = CANVAS.width + 'px';
board.style.height = CANVAS.height + 'px';

// The board keeps the shape it was designed at and scales to whatever window
// opens it, so the layout survives the trip.
function fit() {
  const wrap = board.parentElement;
  const scale = Math.min(1, (wrap.clientWidth - 44) / CANVAS.width);
  board.style.transform = 'scale(' + scale + ')';
  wrap.style.height = (CANVAS.height * scale + 20) + 'px';
}
addEventListener('resize', fit);
fit();

for (const c of CHARTS) {
  const card = document.createElement('div');
  card.className = 'card';
  const box = c.box || {x:20, y:20, width:420, height:320};
  card.style.left = box.x + 'px';
  card.style.top = box.y + 'px';
  card.style.width = box.width + 'px';
  card.style.height = box.height + 'px';

  card.innerHTML = '<h2>' + esc(c.title) + '</h2><div class="meta">' + esc(c.meta) + '</div>' +
    (c.kind === 'kpi' ? '' : '<div class="crumbs"></div>') +
    '<div class="viz"></div>' +
    c.notes.map(n => '<div class="note"><b>' + (n.author === 'agent' ? 'Agent' : 'Analyst') + '</b> · ' + esc(n.text) + '</div>').join('');
  board.appendChild(card);

  if (c.kind === 'kpi') { drawKPI(c, card); continue; }
  draw(c, c.spec, [], card);
}

function drawKPI(c, card) {
  const k = c.kpi;
  const holder = card.querySelector('.viz');
  if (!k) { holder.textContent = '—'; return; }
  let html = '<div class="kpi"><div class="kpi-value' + (k.negative ? ' neg' : '') + '">' + esc(k.value) + '</div>' +
    '<div class="kpi-label">' + esc(k.label) + '</div>';
  if (k.delta) {
    html += '<div class="kpi-delta ' + (k.delta.partial ? 'partial' : k.delta.up ? 'up' : 'down') + '">' +
      esc(k.delta.pct) + '<span class="kpi-vs">' + esc(k.delta.vs) + '</span></div>';
  }
  html += '<div class="kpi-rows">' + esc(k.rows) + '</div></div>';
  holder.innerHTML = html;
}

function draw(c, spec, path, card) {
  const holder = card.querySelector('.viz');
  const crumbs = card.querySelector('.crumbs');

  crumbs.innerHTML = '';
  if (path.length) {
    const root = document.createElement('button');
    root.className = 'crumb';
    root.textContent = '← ' + c.title;
    root.onclick = () => draw(c, c.spec, [], card);
    crumbs.appendChild(root);
    for (const step of path) {
      const s = document.createElement('span');
      s.className = 'hint';
      s.textContent = '› ' + step;
      crumbs.appendChild(s);
    }
  } else if (Object.keys(c.drill || {}).length) {
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = 'Click a bar to break it down';
    crumbs.appendChild(h);
  }

  // Size the chart to the card it was designed into.
  const sized = JSON.parse(JSON.stringify(spec));
  sized.width = Math.max(160, holder.clientWidth || 300);
  sized.height = Math.max(120, holder.clientHeight || 200);
  sized.autosize = {type:'fit', contains:'padding'};

  vegaEmbed(holder, sized, { actions: false, renderer: 'svg' }).then(res => {
    if (path.length || !c.parentDim) return;
    res.view.addEventListener('click', (evt, item) => {
      const datum = item && item.datum;
      if (!datum) return;
      const key = datum[c.parentDim];
      const options = c.drill[key];
      if (!options) return;
      const names = Object.keys(options);
      if (names.length === 1) return draw(c, options[names[0]], [key + ' by ' + names[0]], card);

      const pick = document.createElement('select');
      pick.innerHTML = '<option value="">Break ' + esc(key) + ' down by…</option>' +
        names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
      pick.onchange = () => { if (pick.value) draw(c, options[pick.value], [key + ' by ' + pick.value], card); };
      crumbs.innerHTML = '';
      crumbs.appendChild(pick);
    });
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
<\/script>
</body>
</html>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ---- the whole board as one image -----------------------------------------

// Standard frames, so a dashboard can go straight into a deck, a print, or a
// phone-shaped social post without being cropped by somebody else.
export async function exportBoardImage(app, { transparent = false } = {}) {
  const charts = app.listCharts();
  if (!charts.length) throw new Error('There is nothing on the dashboard to export.');

  // The canvas already has a size and every card already has a position, so the
  // export is a faithful copy of what is on screen rather than a fresh layout.
  const { width, height } = app.canvas;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // The export is the board, so it uses the board's own palette rather than a
  // pair of hardcoded light and dark defaults.
  const p = derive(app.theme);
  const theme = {
    bg: p.paper,
    card: p.paperRaised,
    rule: p.rule,
    ink: p.ink,
    faint: p.inkFaint,
    accent: p.accent,
    negative: p.negative,
    dark: p.dark,
    display: FONT_STACK(p.font),
  };

  if (!transparent) {
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);
  }

  for (const chart of charts) {
    const box = chart.box ?? { x: 0, y: 0, width: 400, height: 300 };

    if (!transparent) {
      ctx.fillStyle = theme.card;
      ctx.strokeStyle = theme.rule;
      ctx.lineWidth = 1;
      roundRect(ctx, box.x, box.y, box.width, box.height, 4);
      ctx.fill();
      ctx.stroke();
    }

    ctx.fillStyle = theme.ink;
    ctx.font = `600 17px ${theme.display}`;
    ctx.fillText(clip(ctx, chart.spec.title ?? 'Chart', box.width - 28), box.x + 14, box.y + 26);

    const bodyY = box.y + 40;
    const bodyH = box.height - 52;

    if (chart.spec.mark === 'kpi') {
      drawKPI(ctx, app, chart, box, bodyY, bodyH, theme);
      continue;
    }

    try {
      const result = app.evaluate(chart.spec);
      const spec = toVegaLite(app.model, chart, result, { dark: p.dark });
      spec.width = Math.max(160, box.width - 34);
      spec.height = Math.max(120, bodyH - 12);
      spec.autosize = { type: 'fit', contains: 'padding' };
      const bmp = await renderToBitmap(spec, 2);
      if (bmp) {
        const availW = box.width - 28;
        const scale = Math.min(availW / bmp.width, bodyH / bmp.height);
        ctx.drawImage(bmp, box.x + 14 + (availW - bmp.width * scale) / 2, bodyY, bmp.width * scale, bmp.height * scale);
      }
    } catch {
      // A card that cannot render keeps its frame and title, rather than
      // taking the whole export down with it.
    }
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  download(blob, `${slug(app.model.name)}-${width}x${height}.png`);
  return { width, height };
}

// The KPI is HTML on screen, so the export draws it directly.
function drawKPI(ctx, app, chart, box, bodyY, bodyH, theme, reveal = 1) {
  let data;
  try {
    data = computeKPI(app, chart.spec);
  } catch {
    return;
  }
  // During a recording the figure counts up, which reads as the card filling in
  // rather than appearing fully formed.
  if (reveal < 1 && typeof data.value === 'number') {
    data = { ...data, value: data.value * reveal, delta: reveal > 0.85 ? data.delta : null };
  }

  const cx = box.x + box.width / 2;
  const size = Math.min(box.height * 0.34, box.width * 0.26);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = data.value != null && data.value < 0 ? theme.negative : theme.accent;
  ctx.font = `600 ${Math.round(size)}px ${theme.display}`;
  ctx.fillText(formatValue(data.value, data.field), cx, bodyY + bodyH * 0.5);

  ctx.fillStyle = theme.faint;
  ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
  const label = chart.spec.metrics[0].agg === 'ratio' ? chart.spec.metrics[0].field : `${chart.spec.metrics[0].agg.toUpperCase()} of ${chart.spec.metrics[0].field}`;
  ctx.fillText(label, cx, bodyY + bodyH * 0.5 + size * 0.55);

  if (data.delta) {
    const up = data.delta.pct >= 0;
    ctx.fillStyle = data.delta.partial ? theme.faint : up ? theme.accent : theme.negative;
    ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(
      `${up ? '▲' : '▼'} ${Math.abs(data.delta.pct * 100).toFixed(1)}%  ${data.delta.currentLabel} vs ${data.delta.previousLabel}`,
      cx,
      bodyY + bodyH * 0.5 + size * 0.95
    );
  }
  ctx.restore();
}

// ---- animation capture -----------------------------------------------------

/**
 * Replay the canvas as an animation and record it.
 *
 * Charts are re-rendered into an offscreen canvas one at a time, each growing
 * from nothing, so the recording shows the board being built rather than a
 * static board being scrolled.
 */
export async function captureAnimation(app, { format = 'webm', width = 1280, maxHeight = 720, onProgress } = {}) {
  const pal = derive(app.theme);
  const dark = pal.dark;
  const charts = app.listCharts();
  if (!charts.length) throw new Error('There is nothing on the canvas to record.');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  // Size the surface to the board it will hold. A 16:9 frame holding two charts
  // is mostly empty space, and empty space is what the viewer notices.
  const plannedCols = charts.length === 1 ? 1 : charts.length <= 4 ? 2 : 3;
  const plannedRows = Math.ceil(charts.length / plannedCols);
  canvas.height = Math.min(maxHeight, 90 + plannedRows * 300 + (plannedRows - 1) * 20);
  const height = canvas.height;
  const ctx = canvas.getContext('2d');

  // Pre-render each chart at a series of reveal fractions. Vega draws to its own
  // canvas; we composite those frames onto the recording surface.
  const FPS = 25;
  const PER_CHART_MS = 1400;
  const HOLD_MS = 900;
  const steps = Math.round((PER_CHART_MS / 1000) * FPS);

  // Lay the board out for the number of charts there actually are, so a
  // three-chart recording does not leave a blank row at the bottom.
  const cols = charts.length === 1 ? 1 : charts.length <= 4 ? 2 : 3;
  const rows = Math.ceil(charts.length / cols);
  const cellW = Math.floor((width - 40 - (cols - 1) * 20) / cols);
  const cellH = Math.floor((height - 90 - (rows - 1) * 20) / rows);

  const bg = pal.paper;
  const cardBg = pal.paperRaised;
  const rule = pal.rule;
  const ink = pal.ink;
  const faint = pal.inkFaint;

  // Render every chart once, at each reveal fraction, into image bitmaps.
  const rendered = [];
  for (let i = 0; i < charts.length; i++) {
    const chart = charts[i];

    // A KPI has no Vega spec. It is drawn straight onto the frame instead, so
    // it needs no pre-rendered bitmaps at all.
    if (chart.spec.mark === 'kpi') {
      rendered.push({ chart, shots: [], kpi: true });
      onProgress?.(((i + 1) / charts.length) * 0.7);
      continue;
    }

    const result = app.evaluate(chart.spec);
    const shots = [];
    for (let s = 1; s <= steps; s++) {
      const t = ease(s / steps);
      const spec = revealSpec(app.model, chart, result, { dark, t, width: cellW - 24, height: cellH - 54 });
      shots.push(await renderToBitmap(spec));
    }
    rendered.push({ chart, shots });
    onProgress?.(((i + 1) / charts.length) * 0.7);
  }

  const drawFrame = (revealed, activeIdx, activeStep) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = ink;
    ctx.font = `600 22px ${FONT_STACK(pal.font)}`;
    ctx.fillText(app.model.name, 20, 34);
    ctx.fillStyle = faint;
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`${app.model.rowCount.toLocaleString('en-US')} rows · analysed in the browser`, 20, 54);

    // Draw every card frame from the first frame onward, and reveal only the
    // contents. The viewer sees a board filling up, not a board being built out
    // of nothing, which reads far better and avoids a half-empty opening shot.
    for (let i = 0; i < rendered.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      // A chart left alone on the final row spans the full width rather than
      // sitting beside an empty rectangle.
      const alone = row === rows - 1 && rendered.length % cols === 1 && col === 0;
      const w = alone ? cellW * cols + 20 * (cols - 1) : cellW;
      const x = 20 + col * (cellW + 20);
      const y = 76 + row * (cellH + 20);

      ctx.fillStyle = cardBg;
      ctx.strokeStyle = rule;
      ctx.lineWidth = 1;
      roundRect(ctx, x, y, w, cellH, 3);
      ctx.fill();
      ctx.stroke();

      // A card not yet reached shows its title greyed, so the board reads as a
      // plan being filled in rather than a gap.
      const pending = i > revealed;
      ctx.fillStyle = pending ? faint : ink;
      ctx.font = `600 15px ${FONT_STACK(pal.font)}`;
      ctx.fillText(clip(ctx, rendered[i].chart.spec.title ?? 'Chart', w - 24), x + 12, y + 26);
      if (pending) continue;

      if (rendered[i].kpi) {
        // The number counts up as the card is revealed.
        const t = i === activeIdx ? ease((activeStep + 1) / steps) : 1;
        drawKPI(ctx, app, rendered[i].chart, { x, y, width: w, height: cellH }, y + 38, cellH - 54, {
          bg: cardBg,
          card: cardBg,
          rule,
          ink,
          faint,
          accent: pal.accent,
          negative: pal.negative,
          display: FONT_STACK(pal.font),
        }, t);
        continue;
      }

      const shot = i === activeIdx ? rendered[i].shots[activeStep] : rendered[i].shots[steps - 1];
      if (shot) {
        // Keep the pre-rendered bitmap's aspect ratio, centred in its cell.
        const availW = w - 24;
        const availH = cellH - 54;
        const scale = Math.min(availW / shot.width, availH / shot.height);
        const dw = shot.width * scale;
        const dh = shot.height * scale;
        ctx.drawImage(shot, x + 12 + (availW - dw) / 2, y + 38 + (availH - dh) / 2, dw, dh);
      }
    }
  };

  // Build the whole frame sequence up front, so recording is just playback.
  const sequence = [];
  for (let i = 0; i < rendered.length; i++) {
    for (let s = 0; s < steps; s++) sequence.push([i, i, s]);
  }
  const holdFrames = Math.round((HOLD_MS / 1000) * FPS);
  for (let h = 0; h < holdFrames; h++) sequence.push([rendered.length - 1, -1, 0]);

  if (format === 'gif') return encodeGIF(canvas, ctx, drawFrame, sequence, FPS, onProgress);
  return encodeWebM(canvas, drawFrame, sequence, FPS, onProgress);
}

function encodeWebM(canvas, drawFrame, sequence, fps, onProgress) {
  return new Promise((resolve, reject) => {
    const stream = canvas.captureStream(fps);
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) return reject(new Error('This browser cannot record video.'));

    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = () => resolve({ blob: new Blob(parts, { type: 'video/webm' }), ext: 'webm' });
    rec.onerror = reject;
    rec.start();

    let i = 0;
    const tick = () => {
      if (i >= sequence.length) {
        setTimeout(() => rec.stop(), 200);
        return;
      }
      drawFrame(...sequence[i]);
      onProgress?.(0.7 + (i / sequence.length) * 0.3);
      i++;
      setTimeout(tick, 1000 / fps);
    };
    tick();
  });
}

async function encodeGIF(canvas, ctx, drawFrame, sequence, fps, onProgress) {
  if (typeof GIF === 'undefined') throw new Error('The GIF encoder is still loading. Try again in a moment.');

  // GIF is a poor fit for this and the numbers are brutal: 256 colours, no
  // interframe compression, and quantisation that runs in the page. Encoding
  // the full sequence at full size takes minutes. So the GIF is deliberately a
  // reduced artefact: half the width, every fourth frame, 12fps playback. Use
  // the WebM if quality matters.
  const scale = 0.5;
  const STRIDE = 4;

  // A Worker cannot be constructed from another origin, so pointing gif.js at
  // the CDN copy of its worker fails outright: the browser refuses the script
  // before any encoding starts. Fetch it once and run it from a same-origin
  // blob instead.
  const workerUrl = await gifWorkerURL();

  const gif = new GIF({
    workers: 4,
    quality: 20, // higher number, coarser palette, much faster
    dither: false,
    width: Math.round(canvas.width * scale),
    height: Math.round(canvas.height * scale),
    workerScript: workerUrl,
  });

  const small = document.createElement('canvas');
  small.width = Math.round(canvas.width * scale);
  small.height = Math.round(canvas.height * scale);
  const sctx = small.getContext('2d');

  for (let i = 0; i < sequence.length; i += STRIDE) {
    drawFrame(...sequence[i]);
    sctx.drawImage(canvas, 0, 0, small.width, small.height);
    gif.addFrame(sctx, { copy: true, delay: Math.round((1000 / fps) * STRIDE) });
    if (i % 12 === 0) {
      onProgress?.(0.7 + (i / sequence.length) * 0.2);
      await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
    }
  }

  return new Promise((resolve, reject) => {
    gif.on('progress', (p) => onProgress?.(0.9 + p * 0.1));
    gif.on('finished', (blob) => resolve({ blob, ext: 'gif' }));
    gif.on('abort', () => reject(new Error('GIF encoding was cancelled.')));
    gif.render();
  });
}

// Fetched once per session and kept, because the file is ~20KB and a recording
// may be made several times.
let cachedWorkerURL = null;

async function gifWorkerURL() {
  if (cachedWorkerURL) return cachedWorkerURL;
  const res = await fetch('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js');
  if (!res.ok) throw new Error('Could not load the GIF encoder. Check the connection, or use the video instead.');
  const source = await res.text();
  cachedWorkerURL = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  return cachedWorkerURL;
}

export function downloadCapture({ blob, ext }, name) {
  download(blob, `${slug(name)}.${ext}`);
}

// Build a Vega-Lite spec showing only the first `t` of the data, so successive
// frames read as the chart drawing itself.
function revealSpec(model, chart, result, { dark, t, width, height }) {
  const spec = toVegaLite(model, chart, result, { dark });
  spec.width = Math.max(120, width);
  spec.height = Math.max(100, height);
  spec.autosize = { type: 'fit', contains: 'padding' };

  // A choropleth is a layered spec: a grey outline of every shape, and a data
  // layer joined on top. It has no top-level mark or encoding, so it cannot be
  // revealed by trimming an axis — but it can be revealed by filling the
  // shapes in, biggest first, which is how someone reading the map would take
  // it in anyway. The grey base is drawn from the first frame so the country
  // never pops into existence.
  if (spec.layer) {
    const dataLayer = spec.layer.find((l) => l.name === 'geo_data');
    const lookup = dataLayer?.transform?.find((tr) => tr.from?.data?.values);
    const rows = lookup?.from?.data?.values;
    const alias = dataLayer?.encoding?.color?.field;
    if (!dataLayer || !Array.isArray(rows) || !rows.length || !alias) return spec;

    // Freeze the colour scale across the whole reveal, or each frame rescales
    // to its own subset and the finished states change colour as others arrive.
    const nums = rows.map((r) => r[alias]).filter((v) => typeof v === 'number');
    if (nums.length) {
      const lo = Math.min(...nums);
      const hi = Math.max(...nums);
      dataLayer.encoding.color.scale = {
        ...(dataLayer.encoding.color.scale ?? {}),
        domain: lo < 0 && hi > 0 ? [lo, 0, hi] : [lo, hi],
      };
    }

    // Largest magnitude first: the eye goes to California and New York before
    // the states that barely register, which is the order the narration wants.
    const ordered = [...rows].sort((a, b) => Math.abs(b[alias] ?? 0) - Math.abs(a[alias] ?? 0));
    const n = Math.max(1, Math.ceil(ordered.length * t));
    lookup.from.data = { values: ordered.slice(0, n) };
    return spec;
  }

  // A KPI is not a Vega chart at all, so there is nothing here to reveal.
  // Reaching into spec.encoding without checking is what stopped every
  // recording that had a map or a KPI on the board.
  if (!spec.encoding) return spec;

  const mark = typeof spec.mark === 'string' ? spec.mark : spec.mark?.type;
  const values = spec.data?.values;
  if (!Array.isArray(values) || !values.length) return spec;

  if (mark === 'line' || mark === 'area') {
    // A line traces itself left to right.
    const n = Math.max(2, Math.ceil(values.length * t));
    spec.data = { values: values.slice(0, n) };
    const yField = spec.encoding.y?.field;
    const xField = spec.encoding.x?.field;
    if (!yField || !xField) return spec;
    // Freeze the axes so the chart does not rescale as it draws.
    const max = Math.max(...values.map((v) => v[yField] ?? 0));
    const min = Math.min(0, ...values.map((v) => v[yField] ?? 0));
    spec.encoding.y.scale = { domain: [min, max] };
    spec.encoding.x.scale = { domain: values.map((v) => v[xField]) };
    return spec;
  }

  if (mark === 'arc') {
    const field = spec.encoding.theta?.field;
    if (!field) return spec;
    spec.encoding.theta = { ...spec.encoding.theta, stack: true };
    spec.data = { values: values.map((v) => ({ ...v, [field]: (v[field] ?? 0) * t })) };
    return spec;
  }

  // Bars and points grow from the baseline.
  const q = spec.encoding.y?.type === 'quantitative' ? 'y' : 'x';
  const field = spec.encoding[q]?.field;
  if (!field) return spec;
  const all = values.map((v) => v[field] ?? 0);
  spec.encoding[q].scale = { domain: [Math.min(0, ...all), Math.max(0, ...all)] };
  spec.data = { values: values.map((v) => ({ ...v, [field]: (v[field] ?? 0) * t })) };
  return spec;
}

async function renderToBitmap(spec, scale = 1.5) {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0';
  document.body.append(holder);
  try {
    const res = await vegaEmbed(holder, spec, { actions: false, renderer: 'canvas' });
    const url = await res.view.toImageURL('png', scale);
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob);
    res.view.finalize();
    return bmp;
  } catch {
    return null;
  } finally {
    holder.remove();
  }
}

const ease = (t) => 1 - Math.pow(1 - t, 3);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clip(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 4 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
  return s + '…';
}
