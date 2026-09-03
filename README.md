# Data Playground

Build charts with an agent that never reads your data. Bytes uploaded: 0.

**Live demo:** <!-- TODO: add the deployed URL here -->
**Requires:** ChatGPT's in-app browser, or Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled.
The page works without WebMCP too, by hand.

## The problem

Nobody pastes a real sales export into a chat window. Payroll, pipeline, patient
counts, unit economics: the data most worth analysing is the data you are least
allowed to upload. So the analysis either does not happen, or it happens in a
spreadsheet, by hand, badly.

The obvious fix is to send the file to a model. That is exactly the thing you
cannot do.

## What this does instead

Drop a CSV on the page. It is parsed in the tab. There is no server, no upload,
no request that carries your data anywhere, and the header shows a byte counter
that stays at zero.

The page then reads the file and builds a **semantic model** of it: which columns
are measures and which are dimensions, which measures are safe to add up, which
are rates that must be averaged, which are ratios that must be recomputed rather
than averaged, what the date range is, how many distinct values each field holds.

That model is what the agent gets. Through WebMCP the agent can ask what the
fields mean, run grouped aggregations, draw charts, drill into a category, define
new measures and leave notes on the canvas. What it never gets is a row.

A question like "why is the West region underperforming?" is answered by three
chained tool calls returning about forty numbers in total. Nine thousand rows
stay in the tab.

## It works with no agent at all

The agent is the second half of the product, not the price of admission. Opened
in a browser with no WebMCP support, the page is a complete dashboard tool:

- **A starting point, named.** Load a file and the page asks one question with
  two answers: build your first chart, or take an example dashboard built from
  your own columns.
- **One toolbar.** The dataset, the filters that apply to every chart, a single
  **New chart** button, **Export**, and **Clear all**. Nothing else competes for
  the same job.
- **One panel to build a chart.** Measure, aggregation, breakdown, split, type,
  title, per-chart filters, and a live preview before you commit. The same
  semantic rules apply as they do to the agent: `SUM` is not offered for a rate,
  a ratio can only be aggregated as a ratio, and a pie is disabled when the data
  has negative values or too many slices to read.
- **Eight card types**, including a big-number KPI with a period-on-period
  change, and a choropleth map for columns the page recognises as places.
- **A free canvas.** The board is a fixed shape you choose (1920 × 1080, square,
  portrait, or a 1280 × 720 slide), drawn to scale. Cards are dragged by their
  grip and resized from the corner, and each type has a minimum below which it
  stops being legible and simply refuses to shrink.
- **Restyling.** Three colours and a typeface, applied to the board, every chart
  and the exports at once. The theme dresses the dashboard, not the application:
  the toolbar and rails stay neutral, so a dark board can be judged against a
  surround that is not also dark. Chart series are derived from the accent so a
  board stays coherent, and a colour that would be invisible against the chosen
  paper is lightened until it is not.
- **Filters that read as sentences.** "Region is West", not a bare chip. Several
  at once, and either on the whole dashboard from the context bar or on a single
  card from the card itself, without opening anything.
- **Drag cards to reorder** the dashboard, dropping past the last card to send
  one to the end, and widen any card to two columns.
- **Click a bar to drill into it**, the same behaviour as the agent's
  `drill_down`, with the same breadcrumb.
- **Edit any chart** later through the same panel.

Everything a person does this way is visible to the agent when one is connected,
and the reverse. There is one dashboard, not two.

## Exports

All produced in the tab, from data already in the tab.

**Interactive HTML dashboard.** A single self-contained file with every chart,
the analyst's notes, and working drill-down: click a bar and it breaks down by
the next dimension, with a breadcrumb back. Only aggregated results are written
into the file, plus one pre-computed level of breakdowns, so it can be sent to
somebody who is not cleared to see the underlying rows. Typically under 100 KB.

**Styling is a tool, not a settings page.** `set_theme` and `apply_palette` are
registered alongside the analysis tools, so "make this match our brand, we use
#c0392b" is a thing to say rather than a menu to find. The page pushes back when
a choice would cost the board its meaning: asking for an accent that is nearly
the same colour as the loss colour returns a warning that gains and losses will
then look alike.

**Maps and headline numbers.** A column of US states is recognised as geography
by its values rather than its name, so a file whose column is called "Location"
still gets a map, and one called "State" holding "solid"/"liquid" does not.
`describe_dataset` reports which columns are geographic, so the agent knows a map
is available without guessing.

A KPI card compares the latest period with the one before it. Where the data
stops partway through a period, the card says so instead of reporting a collapse
that is really just a half-finished year.

**Board image, at a standard size.** The whole dashboard composed to
1920 × 1080, 1920 × 1920, 1080 × 1920, or fitted to its content, so it drops
into a deck or a social post without being cropped by somebody else. Card order
follows the order you dragged them into.

**Single chart as a transparent PNG.** Rendered from the live view at 2x, with a
genuinely transparent ground.

**Video.** Records the board building itself, each chart growing from its
baseline, as a WebM. A three-chart board comes out around 300 KB for five
seconds at 1280 wide, encoded by the browser with no library involved.

**GIF.** The same animation, for pasting somewhere that will not take a video.
Encoded in the page at half size and every fourth frame, which keeps a
five-card board to about 0.9 MB in a few seconds. It is still the weaker format
(256 colours, no interframe compression), so prefer the video where one will
do.

Both recordings draw the KPI cards themselves, counting the headline number up
as the board fills in, since a KPI has no Vega spec to reveal.

## Why WebMCP, specifically

This is not a chatbot with a plotting API behind it. Three things here only work
because the tools run inside the page:

**The data cannot leave, architecturally.** Not as a policy, not as a promise in
a privacy page. There is no server to send it to. A server-side agent could not
offer this, because the file would have to reach the server to be analysed.

**The page corrects the agent.** A model handed a raw CSV will average a profit
margin, sum a discount rate, and draw a pie chart of a column containing negative
numbers. All three produce confident, wrong answers. Here all three are refused,
with an explanation the agent can act on:

```
Rejected: "Profit Margin" is a ratio (SUM(Profit) / SUM(Sales)). Averaging or
summing a ratio per row gives the wrong answer. It is recomputed from its
components automatically, so use agg "ratio".
```

The page knows more about the data than the agent does, and says so. That is the
inversion WebMCP makes possible.

**One canvas, two operators.** A filter the analyst sets with the mouse is
reported back to the agent by `describe_dataset` and applied to everything the
agent draws. A chart the agent draws can be pinned by the analyst, at which point
`remove_chart` refuses to delete it. Notes from both sides sit on the same cards.
Neither party is driving a copy of the state.

## How WebMCP is used

Tools are registered with the browser's model context:

```js
document.modelContext.registerTool({
  name: "query_data",
  description: "Group, filter and aggregate the dataset, and get the numbers back as a table.",
  inputSchema: {
    type: "object",
    properties: {
      groupBy: { type: "array", items: { /* field + optional time grain */ } },
      metrics: { type: "array", items: { /* field + aggregation */ } },
      filters: { type: "array", items: { /* col, op, value */ } }
    },
    required: ["metrics"]
  },
  execute: async ({ groupBy, metrics, filters }) => {
    const result = runQuery(app.model, { groupBy, metrics, filters });
    return formatResult(app.model, result);   // aggregates only, never rows
  }
});
```

### Tools are registered dynamically

Before a file is loaded, two tools exist: `load_sample_dataset` and
`get_canvas_status`. There is nothing else an agent could usefully do, so nothing
else is offered.

When data arrives, sixteen more are registered (eighteen tools in total), and
their schemas are rebuilt
from the actual file: field names become enum values, and the descriptions carry
the real column list. The agent stops guessing column names because guessing is
no longer possible. Every time a calculated field is added the data tools are
torn down via their `AbortController` and re-registered, so a field invented
thirty seconds ago is a first-class citizen of the schema.

### The full set

| Tool | |
|---|---|
| `describe_dataset` | The model: fields, roles, aggregation rules, ranges, and the filters the human set |
| `get_field_values` | Distinct values of a dimension, so filters land on values that exist |
| `define_ratio_measure` | Add a ratio, computed as SUM(a)/SUM(b) at every level |
| `define_calculated_field` | Add a derived field: arithmetic, `days_between(a, b)`, or `bucket(f, ...)` |
| `query_data` | Group, filter, aggregate; returns a table of aggregates |
| `drill_down` | Narrow to one category and re-group by a finer dimension |
| `find_outliers` | Biggest contributors, biggest losses, anything beyond two standard deviations |
| `create_chart` | Add a chart, KPI or map; the page picks the encoding, format and colour treatment |
| `update_chart` | Change a chart in place, so the canvas keeps its layout |
| `list_charts` | What is on the canvas, including the human's filters, pins and notes |
| `remove_chart` | Remove a chart, unless the human pinned it |
| `annotate_chart` | Attach a finding to a chart so it outlives the conversation |
| `set_global_filter` | Operate the same canvas-wide filter the human operates |
| `get_canvas_status` | Where things stand, safe to call at any time |
| `set_theme` | Restyle everything: accent, loss colour, paper, typeface |
| `apply_palette` | Apply one of the ready-made palettes |
| `get_theme` | Report the current styling and what else is available |

Every one of these has a hand-operated equivalent in the interface. The tools are
a second way in, not a private back door.

Read-only tools carry `readOnlyHint: true`, so an agent can explore without
prompting the user for confirmation at every step.

## A worked example

With the sample retail data loaded:

1. `create_chart` — profit by sub-category. Three bars come out red.
2. `find_outliers` — Tables is losing 17,725 across 319 orders.
3. `define_calculated_field` — `bucket(Discount, 0, 0.2, 0.4)`, a field the file
   does not contain.
4. `create_chart` — profit by discount band. The agent asks for a pie; the page
   draws bars instead and says why, because a pie cannot represent a negative
   value.

Orders discounted over 40% lose 122,616 across the whole book. That finding is not in any column of the
CSV. It came from a field invented mid-conversation, and the underlying rows
never left the browser.

## Running it

Any static file server over HTTPS (or `localhost`, which also counts as a secure
context):

```sh
python3 -m http.server 8823
```

Then open `http://localhost:8823`. No build step and no dependencies to install.
Vega-Lite is loaded from a CDN for rendering only; it receives aggregated results,
never the source file.

## Notes on the implementation

- `src/core/model.js` — type inference and the aggregation rules
- `src/core/query.js` — grouping, filtering, time grains, ratio arithmetic
- `src/core/registry.js` — dynamic registration and teardown
- `src/tools/` — the WebMCP tools, in three layers: model, query, canvas
- `src/ui/panel.js` — the chart panel, and the rules about which aggregations
  and marks are offered for a given field
- `src/ui/export.js` — PNG, the standalone dashboard, the fixed-size board
  image, and the animation capture
- `src/core/csv.js` — a dependency-free CSV reader, because a page that promises
  your file goes nowhere should not fetch a parser from a stranger to read it

## Licence

MIT. See [LICENSE](LICENSE).
