// Theming.
//
// A dashboard usually has to look like it belongs to somebody: a company deck,
// a report, a client's brand. Three colours and a typeface get you most of the
// way there, so those are what the page exposes, to the person and to the agent
// alike.
//
// Deliberately not "pick any colour for anything". The palette is a system:
// one accent that carries the data, one for losses, one ground, and the chart
// series are derived from the accent so a board stays coherent.

export const FONTS = {
  ledger: {
    label: 'Ledger',
    display: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Times New Roman', serif",
    body: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    note: 'A bookkeeper’s serif over a plain sans. The default.',
  },
  grotesque: {
    label: 'Grotesque',
    display: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    body: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    note: 'One neutral sans throughout. Corporate, quiet.',
  },
  editorial: {
    label: 'Editorial',
    display: "Georgia, 'Times New Roman', serif",
    body: "Georgia, 'Times New Roman', serif",
    note: 'Serif throughout, for something that reads as a document.',
  },
  mono: {
    label: 'Technical',
    display: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    body: "ui-sans-serif, system-ui, -apple-system, sans-serif",
    note: 'Monospaced headings. Engineering-report flavour.',
  },
};

export const PRESETS = {
  ledger: { label: 'Ledger', accent: '#1f4f82', negative: '#a8322a', paper: '#f2f3f0', font: 'ledger' },
  slate: { label: 'Slate', accent: '#3f4d5a', negative: '#a4553a', paper: '#f4f5f6', font: 'grotesque' },
  forest: { label: 'Forest', accent: '#2f6146', negative: '#a8322a', paper: '#f1f4f0', font: 'editorial' },
  plum: { label: 'Plum', accent: '#6b3fa0', negative: '#b5527a', paper: '#f4f1f7', font: 'ledger' },
  ink: { label: 'Ink', accent: '#1b2027', negative: '#a8322a', paper: '#f5f4f1', font: 'mono' },
};

export const DEFAULT_THEME = { accent: '#1f4f82', negative: '#a8322a', paper: '#f2f3f0', font: 'ledger' };

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normaliseHex(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(HEX);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return `#${hex.toLowerCase()}`;
}

// ---- colour maths ---------------------------------------------------------
// Enough to derive a coherent set from one accent, without a colour library.

function hexToRgb(hex) {
  const h = normaliseHex(hex) ?? '#000000';
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function rgbToHex([r, g, b]) {
  const to = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

export function lighten(hex, amount) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return rgbToHex(hslToRgb([h, s, Math.max(0, Math.min(1, l + amount))]));
}

export function mix(hex, other, weight) {
  const a = hexToRgb(hex);
  const b = hexToRgb(other);
  return rgbToHex(a.map((v, i) => v * (1 - weight) + b[i] * weight));
}

// Relative luminance, for deciding whether text on this colour should be light
// or dark. Contrast is not a preference: unreadable is unreadable.
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function readableOn(hex) {
  return luminance(hex) > 0.45 ? '#1b2027' : '#ffffff';
}

export function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// Walk a colour's lightness towards the far side of its background until it
// clears a usable contrast, keeping the hue. 3:1 is the WCAG threshold for
// graphical objects, which is what a chart series is.
const MIN_DATA_CONTRAST = 4;

function ensureVisible(hex, paper) {
  if (contrast(hex, paper) >= MIN_DATA_CONTRAST) return hex;
  const towardsLight = luminance(paper) < 0.4;
  let out = hex;
  for (let i = 0; i < 20; i++) {
    out = lighten(out, towardsLight ? 0.04 : -0.04);
    if (contrast(out, paper) >= MIN_DATA_CONTRAST) break;
  }
  return out;
}

/**
 * Derive the full working palette from the three chosen colours.
 *
 * The categorical series are rotations around the accent's hue rather than a
 * fixed rainbow, so a board themed plum does not sprout unrelated oranges.
 */
export function derive(theme) {
  const rawAccent = normaliseHex(theme.accent) ?? DEFAULT_THEME.accent;
  const rawNegative = normaliseHex(theme.negative) ?? DEFAULT_THEME.negative;
  const paper = normaliseHex(theme.paper) ?? DEFAULT_THEME.paper;

  // A colour chosen against white can disappear against a dark ground. Nudge
  // the lightness until the data is actually visible on the paper it sits on,
  // rather than honouring the hex literally and drawing something nobody can
  // see. The hue is preserved, so it still reads as the colour that was asked
  // for.
  const accent = ensureVisible(rawAccent, paper);
  const negative = ensureVisible(rawNegative, paper);

  const [h, s] = rgbToHsl(hexToRgb(accent));
  const series = [0, 0.55, 0.28, 0.75, 0.14, 0.62, 0.4, 0.85].map((shift, i) => {
    const hue = (h + shift) % 1;
    const sat = Math.max(0.18, Math.min(0.62, s * (i === 0 ? 1 : 0.82)));
    const light = 0.42 + (i % 3) * 0.07;
    return rgbToHex(hslToRgb([hue, sat, light]));
  });
  series[0] = accent;

  const dark = luminance(paper) < 0.35;

  return {
    accent,
    negative,
    paper,
    font: theme.font ?? 'ledger',
    dark,
    series,
    // Surfaces are tinted by the paper, so the whole page shifts together.
    paperRaised: dark ? lighten(paper, 0.05) : lighten(paper, 0.035),
    rule: dark ? lighten(paper, 0.1) : mix(paper, '#000000', 0.12),
    ruleStrong: dark ? lighten(paper, 0.18) : mix(paper, '#000000', 0.22),
    ink: dark ? '#e8e6e3' : mix(paper, '#000000', 0.86),
    inkSoft: dark ? '#a8afb8' : mix(paper, '#000000', 0.6),
    inkFaint: dark ? '#767d86' : mix(paper, '#000000', 0.42),
    accentSoft: mix(paper, accent, dark ? 0.22 : 0.14),
    negativeSoft: mix(paper, negative, dark ? 0.22 : 0.12),
    onAccent: readableOn(accent),
    // If the accent and the loss colour are too close, the board loses its most
    // important distinction: which numbers are bad. Report it rather than
    // silently drawing a chart where profit and loss look identical.
    accentClashesWithNegative: contrast(accent, negative) < 1.6,
  };
}

/**
 * Push the palette into CSS custom properties.
 *
 * The theme belongs to the *dashboard*, not to the application. Paper is the
 * colour of the board you are designing, the thing that ends up in the export;
 * the toolbar, the side rail and the panel are the tool you are designing it
 * with, and they stay put. Repainting the whole application every time somebody
 * tries a background colour makes the tool unusable, and makes it impossible to
 * judge the board against a neutral surround.
 */
export function applyTheme(theme, root = document.documentElement) {
  const p = derive(theme);
  const font = FONTS[p.font] ?? FONTS.ledger;
  const set = (name, value) => root.style.setProperty(name, value);

  // Board tokens: everything inside the canvas, and the exports.
  set('--board-paper', p.paper);
  set('--board-card', p.paperRaised);
  set('--board-rule', p.rule);
  set('--board-rule-strong', p.ruleStrong);
  set('--board-ink', p.ink);
  set('--board-ink-soft', p.inkSoft);
  set('--board-ink-faint', p.inkFaint);
  set('--board-accent', p.accent);
  set('--board-accent-soft', p.accentSoft);
  set('--board-negative', p.negative);
  set('--board-negative-soft', p.negativeSoft);
  set('--board-on-accent', p.onAccent);
  set('--board-display', font.display);
  set('--board-sans', font.body);

  // The one thing the theme is allowed to change outside the board: the accent
  // on interface controls, so a themed session still feels like one piece.
  set('--accent', p.accent);
  set('--accent-soft', mix('#ffffff', p.accent, 0.12));
  set('--on-accent', p.onAccent);

  return p;
}
