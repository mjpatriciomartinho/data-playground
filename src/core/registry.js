// Dynamic tool registration.
//
// Before a dataset is loaded there is exactly one thing an agent can usefully
// do, so exactly one tool exists. Once data arrives, the analysis tools appear,
// and their schemas are rebuilt to carry the real field names as enums, split
// by role: a measure slot offers only measures, a dimension slot only
// dimensions. The agent stops guessing column names because a name outside the
// enum is not a representable call.
//
// registerDataTools also runs on every model change, so a field created by
// define_calculated_field is in the enums before the agent's next call.

import { registerModelTools } from '../tools/model-tools.js';
import { registerQueryTools } from '../tools/query-tools.js';
import { registerCanvasTools } from '../tools/canvas-tools.js';

const mc = () => document.modelContext ?? navigator.modelContext;

/**
 * Register one tool with the browser's model context.
 *
 * This is the documented WebMCP call, in the documented shape:
 *
 *   document.modelContext.registerTool({
 *     name: "search_products",
 *     description: "Search the product catalog",
 *     inputSchema: { ... },
 *     execute: async (input) => { ... }
 *   });
 *
 * It lives in one place so the AbortSignal that unregisters a whole stage is
 * applied consistently. The `navigator.modelContext` fallback is there for
 * builds that predate the move to `document`.
 */
export function registerTool(definition, options) {
  if (document.modelContext) {
    return document.modelContext.registerTool(definition, options);
  }
  return navigator.modelContext.registerTool(definition, options);
}

export class ToolRegistry {
  constructor(app) {
    this.app = app;
    this.loaderController = null;
    this.dataController = null;
    this.active = [];
  }

  get supported() {
    return Boolean(mc());
  }

  // Stage one: no data yet.
  registerLoaderTools() {
    const ctx = mc();
    if (!ctx) return;
    this.loaderController?.abort();
    this.loaderController = new AbortController();
    const signal = this.loaderController.signal;

    registerTool(
      {
        name: 'load_sample_dataset',
        description:
          'Load the bundled sample dataset, a retail order book with sales, profit, discounts, ' +
          'products, customers, regions and dates. Use it when the user has not supplied a file ' +
          'of their own and wants to try the tool. After loading, call describe_dataset.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          const summary = await this.app.loadSample();
          return `Loaded the sample dataset.\n\n${summary}`;
        },
      },
      { signal }
    );

    registerTool(
      {
        name: 'get_canvas_status',
        description:
          'Report whether a dataset is loaded, how many rows it has, and how many charts are on ' +
          'the canvas. Safe to call at any time to find out where things stand.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => {
          if (!this.app.model) {
            return 'No dataset loaded. The user can drop a CSV onto the page, or you can call load_sample_dataset. No data has been or will be uploaded anywhere: parsing happens in this tab.';
          }
          return (
            `Dataset "${this.app.model.name}": ${this.app.model.rowCount.toLocaleString('en-US')} rows, ` +
            `${this.app.model.fieldNames().length} fields, ${this.app.listCharts().length} chart(s) on the canvas. ` +
            `Call describe_dataset for the field list.`
          );
        },
      },
      { signal }
    );

    this.active = ['load_sample_dataset', 'get_canvas_status'];
    this.app.onToolsChanged(this.active);
  }

  // Stage two: data is loaded, so the analysis surface opens up.
  registerDataTools() {
    const ctx = mc();
    if (!ctx) return;
    // Re-registering a name without aborting first is an error, so tear the old
    // set down before building the new one. This also runs on every model change,
    // which is how new calculated fields reach the agent's schemas.
    this.dataController?.abort();
    this.dataController = new AbortController();
    const signal = this.dataController.signal;

    const names = [
      ...registerModelTools(this.app, signal),
      ...registerQueryTools(this.app, signal),
      ...registerCanvasTools(this.app, signal),
    ];

    this.active = [...new Set([...this.active.filter((n) => n === 'get_canvas_status'), ...names])];
    this.app.onToolsChanged(this.active);
  }

  teardownDataTools() {
    this.dataController?.abort();
    this.dataController = null;
    this.active = ['load_sample_dataset', 'get_canvas_status'];
    this.app.onToolsChanged(this.active);
  }
}
