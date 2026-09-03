// Entry point.

import { App } from './core/app.js';
import { mountUI, flashTool } from './ui/render.js';

const app = new App();
window.app = app; // handy when poking at the page from devtools

// The API moved from navigator.modelContext to document.modelContext, because
// tools belong to a page rather than to the browser. Accept either, so the page
// works on whatever build a visitor happens to have.
const mc = document.modelContext ?? navigator.modelContext;

// Wrap registerTool once, so every tool call lights up in the inspector and
// lands in the activity log. The agent's work is visible to the person watching,
// which is the whole premise of a shared canvas.
if (mc && !mc.__instrumented) {
  const original = mc.registerTool.bind(mc);
  mc.registerTool = (def, opts) =>
    original(
      {
        ...def,
        execute: async (input, ctx) => {
          flashTool(def.name);
          app.log('agent', `called ${def.name}${summariseArgs(input)}`);
          return def.execute(input, ctx);
        },
      },
      opts
    );
  mc.__instrumented = true;
}

function summariseArgs(input) {
  if (!input || typeof input !== 'object') return '';
  const parts = Object.entries(input)
    .filter(([, v]) => v != null && (!Array.isArray(v) || v.length))
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : v}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

app.registry.registerLoaderTools();
mountUI(app);
