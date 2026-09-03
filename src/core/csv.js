// A CSV reader with no dependencies, because the whole promise of this page is
// that your file is not handed to anybody, and that includes a third-party
// bundle fetched from a CDN.
//
// Handles quoted fields, escaped quotes, embedded newlines and commas, CRLF, and
// the byte-order mark that Excel puts at the front of everything it exports.

export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
      continue;
    }

    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (c !== '\r') {
      cur += c;
    }
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }

  if (!rows.length) throw new Error('The file appears to be empty.');

  const header = rows.shift().map((h) => h.trim());
  if (new Set(header).size !== header.length) {
    // Duplicate headers would silently shadow each other in an object row.
    const seen = new Map();
    for (let i = 0; i < header.length; i++) {
      const n = header[i];
      if (seen.has(n)) header[i] = `${n} (${seen.get(n) + 1})`;
      seen.set(n, (seen.get(n) ?? 0) + 1);
    }
  }

  const objects = [];
  for (const r of rows) {
    if (r.length === 1 && r[0] === '') continue; // trailing newline
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = r[i] ?? '';
    objects.push(obj);
  }

  return { header, rows: objects };
}
