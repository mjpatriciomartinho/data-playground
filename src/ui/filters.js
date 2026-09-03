// Filter controls.
//
// A filter used to be a bare dropdown that produced a chip with no explanation
// of what it did or where it applied. Here every filter says its field, its
// operator and its value, and says plainly whether it covers the whole
// dashboard or just one chart.

import { ROLE } from '../core/model.js';
import { OPERATORS } from '../core/query.js';

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) node.append(c);
  return node;
};

// Operators offered per field kind. A "contains" on a number is noise, and a
// "between" needs two values, so it lives in its own control.
function operatorsFor(field) {
  if (!field) return ['='];
  if (field.role === ROLE.MEASURE) return ['=', '!=', '>', '>=', '<', '<='];
  if (field.role === ROLE.TIME) return ['=', '>=', '<=', '!='];
  return ['=', '!=', 'in', 'contains'];
}

const OP_LABEL = {
  '=': 'is',
  '!=': 'is not',
  '>': 'is more than',
  '>=': 'is at least',
  '<': 'is less than',
  '<=': 'is at most',
  in: 'is one of',
  contains: 'contains',
  between: 'is between',
};

export function describeFilter(f) {
  const value = Array.isArray(f.value) ? f.value.join(', ') : f.value;
  return `${f.col} ${OP_LABEL[f.op] ?? f.op} ${value}`;
}

/**
 * A row of filter chips plus an "add" control.
 *
 * @param {App} app
 * @param {object} opts
 * @param {Array} opts.filters       current filters
 * @param {(next:Array)=>void} opts.onChange
 * @param {string} opts.scope        'dashboard' or 'chart', for the wording
 */
export function filterEditor(app, { filters = [], onChange, scope = 'dashboard', compact = false } = {}) {
  const model = app.model;
  const root = el('div', { className: `filters${compact ? ' filters-compact' : ''}` });

  for (const f of filters) {
    const chip = el('div', { className: 'filter-chip' });
    chip.append(
      el('span', { className: 'filter-field', textContent: f.col }),
      el('span', { className: 'filter-op', textContent: OP_LABEL[f.op] ?? f.op }),
      el('span', { className: 'filter-value', textContent: Array.isArray(f.value) ? f.value.join(', ') : String(f.value) })
    );
    const x = el('button', { className: 'filter-x', textContent: '×', title: `Remove this filter` });
    x.onclick = () => onChange(filters.filter((g) => g !== f));
    chip.append(x);
    root.append(chip);
  }

  // The add control is a small inline form rather than a modal: choosing a
  // field, an operator and a value is three decisions, not a dialogue.
  const adder = el('div', { className: 'filter-add' });
  const openBtn = el('button', {
    className: 'filter-add-btn',
    textContent: filters.length ? '+ Add filter' : compact ? '+ Filter this card' : '+ Filter',
    title: compact ? 'Narrow this card only' : 'Narrow every card',
  });

  openBtn.onclick = () => {
    adder.replaceChildren(buildForm());
  };
  adder.append(openBtn);
  root.append(adder);

  function buildForm() {
    const form = el('div', { className: 'filter-form' });

    const dims = [...model.dimensions(), ...model.measures()].filter((d) => !d.identifierLike);
    const fieldSel = el('select', { className: 'filter-select' });
    fieldSel.append(el('option', { value: '', textContent: 'Field…' }));
    for (const d of dims) {
      fieldSel.append(el('option', { value: d.name, textContent: `${d.name}  (${d.role === ROLE.MEASURE ? 'number' : d.role === ROLE.TIME ? 'date' : 'category'})` }));
    }

    const opSel = el('select', { className: 'filter-select', disabled: true });
    const valWrap = el('span', { className: 'filter-val-wrap' });
    const addBtn = el('button', { className: 'primary', textContent: 'Add', disabled: true });

    let valueControl = null;

    const rebuildValue = () => {
      valWrap.replaceChildren();
      const field = model.field(fieldSel.value);
      if (!field) return;

      if (field.role === ROLE.MEASURE) {
        valueControl = el('input', { type: 'number', step: 'any', placeholder: 'Value', className: 'filter-input' });
      } else if (field.role === ROLE.TIME && ['>=', '<='].includes(opSel.value)) {
        valueControl = el('input', { type: 'date', className: 'filter-input' });
      } else {
        // Categorical, or a date compared by period: offer the real values.
        valueControl = el('select', { className: 'filter-select' });
        valueControl.append(el('option', { value: '', textContent: 'Value…' }));
        const vals = model.distinctValues(field.name, 200).map((v) => v.value);
        const sorted = field.role === ROLE.TIME ? [...vals].sort() : vals;
        for (const v of sorted) valueControl.append(el('option', { value: v, textContent: v }));
      }

      valueControl.oninput = valueControl.onchange = () => {
        addBtn.disabled = !valueControl.value;
      };
      valWrap.append(valueControl);
      addBtn.disabled = true;
    };

    fieldSel.onchange = () => {
      const field = model.field(fieldSel.value);
      opSel.replaceChildren();
      if (!field) {
        opSel.disabled = true;
        valWrap.replaceChildren();
        return;
      }
      opSel.disabled = false;
      for (const op of operatorsFor(field)) opSel.append(el('option', { value: op, textContent: OP_LABEL[op] ?? op }));
      rebuildValue();
    };

    opSel.onchange = rebuildValue;

    addBtn.onclick = () => {
      if (!fieldSel.value || !valueControl?.value) return;
      const field = model.field(fieldSel.value);
      const raw = valueControl.value;
      const value = field.role === ROLE.MEASURE ? Number(raw) : raw;
      onChange([...filters, { col: fieldSel.value, op: opSel.value || '=', value }]);
    };

    const cancel = el('button', { className: 'filter-cancel', textContent: 'Cancel' });
    cancel.onclick = () => adder.replaceChildren(openBtn);

    form.append(fieldSel, opSel, valWrap, addBtn, cancel);
    return form;
  }

  return root;
}
