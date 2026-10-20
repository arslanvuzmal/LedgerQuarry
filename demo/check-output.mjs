// After a demo run, checks what the workflow wrote to demo/out/. Used by CI.
//   node demo/check-output.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = (f) => readFileSync(fileURLToPath(new URL(`./out/${f}`, import.meta.url)), 'utf8').replace(/^﻿/, '');

/** Rows of a CSV file as objects (handles quoted fields). */
function rows(text) {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); records.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); records.push(row); }
  const [header, ...body] = records.filter((r) => r.some((c) => c !== ''));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const expected = {
  '1-northwind-INV-1042.pdf': 'AUTO_APPROVED',
  '2-kovacs-print-2044.pdf': 'REVIEW_REQUIRED',
  '3-harbour-CN-77.pdf': 'REVIEW_RECOMMENDED',
};
const problems = [];
const ledger = rows(out('ledger.csv'));
const audit = rows(out('audit-log.csv'));

for (const [file, status] of Object.entries(expected)) {
  const row = ledger.find((r) => r['Attachment Filename'] === file);
  if (!row) problems.push(`ledger.csv has no row for ${file}`);
  else if (row.Status !== status) problems.push(`${file}: status ${row.Status}, expected ${status}`);
  if (!audit.find((r) => r.Filename === file)) problems.push(`audit-log.csv has no row for ${file}`);
}
if (ledger.find((r) => r['Attachment Filename'] === '4-northwind-INV-1001.pdf')) {
  problems.push('the duplicate INV-1001 was written to the ledger');
}
if (ledger.length !== 3) problems.push(`ledger.csv has ${ledger.length} rows, expected 3`);
if (audit.some((r) => /NaN/.test(r['Processing Duration']))) problems.push('audit-log.csv has a NaN processing duration');

if (problems.length) {
  console.error('Demo output is wrong:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`Demo output OK: ${ledger.length} ledger rows, ${audit.length} audit rows, duplicate kept out.`);
