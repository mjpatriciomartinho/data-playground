// The free canvas.
//
// A dashboard is a designed object: the headline goes top left because that is
// where people look first, and the map wants to be wide. A reflowing grid
// cannot express any of that, so cards here carry their own position and size
// on a canvas of a fixed, chosen shape, and the page is drawn to scale.
//
// Coordinates are stored in canvas pixels, not screen pixels, so a layout built
// on a laptop exports identically at 1920 wide.

export const CANVAS_PRESETS = [
  { id: '1920x1080', label: 'Landscape  1920 × 1080', width: 1920, height: 1080 },
  { id: '1920x1920', label: 'Square  1920 × 1920', width: 1920, height: 1920 },
  { id: '1080x1920', label: 'Portrait  1080 × 1920', width: 1080, height: 1920 },
  { id: '1280x720', label: 'Slide  1280 × 720', width: 1280, height: 720 },
];

export const GRID = 20; // cards snap to this, so edges line up without fuss

// Minimums, per card type. A card smaller than this stops being a chart and
// starts being a rectangle with pieces missing, so the resize simply refuses to
// go further. A KPI needs room for its number; a map needs an aspect ratio it
// can project into; a bar chart needs axis labels.
// Every card spends roughly 90px on its own furniture before the chart gets a
// pixel: the header band with its controls, the spec line, and the per-card
// filter row. The minimums below are that overhead plus what the visualisation
// itself needs to stay honest, measured rather than guessed.
const CHROME_H = 92;

// Vega will not draw a cartesian chart shorter than roughly 160px once axis
// labels, tick marks and an axis title are accounted for; asking for less
// produces an SVG taller than its container, which then spills out of the card.
// These floors are measured against what actually renders, not what looks
// tidy in the layout code.
const PLOT_MIN = 170;

const MINIMUMS = {
  kpi: { w: 240, h: CHROME_H + 110 },              // the number, its label, and air
  map: { w: 340, h: CHROME_H + 210 },              // a projection needs real height
  pie: { w: 280, h: CHROME_H + 200 },
  heatmap: { w: 320, h: CHROME_H + PLOT_MIN },
  default: { w: 300, h: CHROME_H + PLOT_MIN },     // axis labels plus a usable plot
};

export const MIN_W = 240;
export const MIN_H = CHROME_H + 110;

export function minimumFor(mark) {
  return MINIMUMS[mark] ?? MINIMUMS.default;
}

export function snap(n) {
  return Math.round(n / GRID) * GRID;
}

export function clampToCanvas(box, canvas, mark) {
  const min = minimumFor(mark);
  const width = Math.max(min.w, Math.min(box.width, canvas.width));
  const height = Math.max(min.h, Math.min(box.height, canvas.height));
  return {
    x: Math.max(0, Math.min(box.x, canvas.width - width)),
    y: Math.max(0, Math.min(box.y, canvas.height - height)),
    width,
    height,
  };
}

/**
 * Find room for a new card.
 *
 * Scans the canvas top to bottom for the first free rectangle. Cards may be
 * dragged to overlap afterwards, but nothing should ever *arrive* on top of
 * something else.
 */
export function findSlot(charts, canvas, size) {
  const w = Math.min(size.width, canvas.width);
  const h = Math.min(size.height, canvas.height);
  const taken = charts.filter((c) => c.box).map((c) => c.box);

  for (let y = 0; y + h <= canvas.height; y += GRID) {
    for (let x = 0; x + w <= canvas.width; x += GRID) {
      const candidate = { x, y, width: w, height: h };
      if (!taken.some((b) => overlaps(b, candidate))) return candidate;
    }
  }
  // A full canvas still has to put the card somewhere: stack it at the bottom.
  const lowest = taken.reduce((m, b) => Math.max(m, b.y + b.height), 0);
  return { x: 0, y: Math.min(lowest, Math.max(0, canvas.height - h)), width: w, height: h };
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// A sensible default size for a card, by what it holds. A KPI is a small tile;
// a time series wants to be wide; a map wants to be square-ish.
export function defaultSize(mark, canvas) {
  // Twelve columns across, six rows down: a five-card board then fits a
  // 1920x1080 canvas without anything hanging off the bottom edge.
  const unit = canvas.width / 12;
  const rowUnit = canvas.height / 6;
  const pick = (cols, rows) => ({
    width: snap(Math.min(canvas.width, cols * unit)),
    height: snap(Math.min(canvas.height, rows * rowUnit)),
  });
  switch (mark) {
    case 'kpi':
      return pick(3, 1.5);
    case 'line':
    case 'area':
      return pick(9, 2);
    case 'map':
      return pick(6, 2.5);
    case 'pie':
      return pick(4, 2.5);
    default:
      return pick(6, 2.5);
  }
}

// Lay out a set of cards that have no positions yet: KPIs across the top, then
// everything else in rows. Used for the example dashboard and for any chart an
// agent adds without saying where it goes.
export function autoArrange(charts, canvas) {
  const kpis = charts.filter((c) => c.spec.mark === 'kpi');
  const rest = charts.filter((c) => c.spec.mark !== 'kpi');

  const pad = GRID;
  const usableW = canvas.width - pad * 2;
  const usableH = canvas.height - pad * 2;

  // Rows are sized from what is left, so the board always fills the canvas
  // instead of clustering in the top-left corner and leaving half of it blank.
  const kpiRowH = kpis.length ? Math.max(MIN_H, Math.round(usableH * 0.2)) : 0;
  const chartRows = Math.max(1, Math.ceil(rest.length / 2));
  const bodyH = usableH - (kpis.length ? kpiRowH + GRID : 0);
  const rowH = Math.max(MIN_H, Math.floor((bodyH - (chartRows - 1) * GRID) / chartRows));

  // KPIs share the top band equally.
  if (kpis.length) {
    const w = Math.floor((usableW - (kpis.length - 1) * GRID) / kpis.length);
    kpis.forEach((chart, i) => {
      chart.box = clampToCanvas({ x: pad + i * (w + GRID), y: pad, width: w, height: kpiRowH }, canvas, 'kpi');
    });
  }

  // Everything else goes two to a row, and a card left alone on the last row
  // takes the full width rather than sitting beside a gap.
  let y = pad + (kpis.length ? kpiRowH + GRID : 0);
  for (let i = 0; i < rest.length; i += 2) {
    const pair = rest.slice(i, i + 2);
    if (pair.length === 1) {
      pair[0].box = clampToCanvas({ x: pad, y, width: usableW, height: rowH }, canvas, pair[0].spec.mark);
    } else {
      const w = Math.floor((usableW - GRID) / 2);
      pair[0].box = clampToCanvas({ x: pad, y, width: w, height: rowH }, canvas, pair[0].spec.mark);
      pair[1].box = clampToCanvas({ x: pad + w + GRID, y, width: usableW - w - GRID, height: rowH }, canvas, pair[1].spec.mark);
    }
    y += rowH + GRID;
  }

  return charts;
}
