// Builds workflows/demo-workflow.json from workflows/workflow.json: the same workflow, runnable
// with no Google account and no Claude key.
//   node scripts/build-demo-workflow.mjs          write the demo workflow
//   node scripts/build-demo-workflow.mjs --check  fail if the committed file is out of date (CI)
//
// What changes, and nothing else:
//   - Gmail and Drive triggers -> a manual trigger that reads the sample PDFs in /demo/inbox.
//   - Claude API Call -> returns the hand-written answer for that file (demo/answers.json).
//   - Check Duplicate -> looks the invoice up in demo/sheet-seed.json, matching on the same three
//     columns as the Google Sheets filter.
//   - Google Sheets appends -> build the same row from the same column expressions, and the
//     ledger and audit log are written as CSV files to /demo/out.
//   - Gmail sends and Google Drive steps -> return what they would have sent or filed.
// Every replaced node keeps its name (expressions such as $('determineStatus') still resolve) and
// shows a note on the canvas saying what it stands in for. The Code nodes with the business logic
// (detectFileType, validateMath, validateFields, classifyConfidence, determineStatus, ...) are copied
// unchanged.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const SOURCE = root('workflows/workflow.json');
const TARGET = root('workflows/demo-workflow.json');
const answers = JSON.parse(readFileSync(root('demo/answers.json'), 'utf8'));
const seed = JSON.parse(readFileSync(root('demo/sheet-seed.json'), 'utf8')).rows;
delete answers._about;

const wf = JSON.parse(readFileSync(SOURCE, 'utf8'));
const byName = (name) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`workflow.json has no node "${name}"`);
  return n;
};

/** An n8n value ("={{ expr }}" or a plain string) as a JavaScript expression. */
const js = (value) => {
  if (typeof value !== 'string') return JSON.stringify(value);
  const m = value.match(/^=\{\{([\s\S]*)\}\}$/);
  return m ? `(${m[1].trim()})` : JSON.stringify(value.replace(/^=/, ''));
};
/** An object literal whose values are the given n8n values. */
const objectOf = (fields) => `{\n${Object.entries(fields).map(([k, v]) => `    ${JSON.stringify(k)}: ${js(v)},`).join('\n')}\n  }`;

function toCode(name, note, jsCode, mode = 'runOnceForEachItem') {
  const n = byName(name);
  const original = n.type.replace('n8n-nodes-base.', '');
  n.type = 'n8n-nodes-base.code';
  n.typeVersion = 2;
  n.parameters = { mode, jsCode: `// DEMO MODE: stands in for the ${original} node "${name}" in workflow.json.\n${jsCode}` };
  n.notes = `Demo mode: ${note}`;
  n.notesInFlow = true;
  delete n.credentials;
  delete n.webhookId;
  delete n.alwaysOutputData;
}

// 1. Triggers: start by hand and read the sample invoices from disk.
const gmailTrigger = byName('Gmail Trigger');
const start = { ...gmailTrigger, name: 'Start demo', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} };
delete start.credentials;
delete start.webhookId;
start.notes = 'Demo mode: stands in for the Gmail and Google Drive triggers.';
start.notesInFlow = true;
const read = {
  id: 'demo-read-samples',
  name: 'Read sample invoices',
  type: 'n8n-nodes-base.readWriteFile',
  typeVersion: 1,
  position: [gmailTrigger.position[0] + 220, gmailTrigger.position[1] + 100],
  parameters: { fileSelector: '/demo/inbox/*.pdf', options: {} },
  notes: 'Demo mode: the sample PDFs in demo/inbox.',
  notesInFlow: true,
};
start.position = [gmailTrigger.position[0], gmailTrigger.position[1] + 100];
wf.nodes = wf.nodes.filter((n) => n.name !== 'Gmail Trigger' && n.name !== 'Google Drive Trigger');
wf.nodes.push(start, read);
const toDetect = wf.connections['Gmail Trigger'].main;
delete wf.connections['Gmail Trigger'];
delete wf.connections['Google Drive Trigger'];
wf.connections['Start demo'] = { main: [[{ node: 'Read sample invoices', type: 'main', index: 0 }]] };
wf.connections['Read sample invoices'] = { main: toDetect };

// 2. Claude: the hand-written answer for this file, in the shape of a Messages API response.
toCode(
  'Claude API Call',
  'returns the hand-written answer for this file from demo/answers.json instead of calling Claude.',
  `const ANSWERS = ${JSON.stringify(answers)};
const file = $('detectFileType').item.json.pdf_filename;
const answer = ANSWERS[file];
if (!answer) return { json: { error: { type: 'demo', message: 'No demo answer for ' + file } } };
return {
  json: {
    type: 'message',
    role: 'assistant',
    model: $json.claude_payload.model,
    content: [{ type: 'text', text: JSON.stringify(answer) }],
    stop_reason: 'end_turn',
  },
};`
);

// 3. Check Duplicate: the same three-column filter, against last month's rows.
const dupFilter = byName('Check Duplicate').parameters.filters.conditions;
toCode(
  'Check Duplicate',
  'looks the invoice up in demo/sheet-seed.json (last month’s rows) with the same filter as the Google Sheets node.',
  `const SHEET = ${JSON.stringify(seed)};
const want = {
${dupFilter.map((c) => `  ${JSON.stringify(c.column)}: ${js(c.value)},`).join('\n')}
};
const row = SHEET.find((r) => Object.entries(want).every(([col, val]) => String(r[col]) === String(val)));
// The production node is set to always output data: an empty item when nothing matches.
return { json: row || {} };`
);

// 4. Sheet appends: the same row, built from the same column expressions.
for (const [name, file] of [['Google Sheets Append', 'ledger.csv'], ['Audit Log', 'audit-log.csv'], ['Error Log', 'error-log.csv']]) {
  const columns = byName(name).parameters.columns.value;
  toCode(name, `builds the row it would append; the rows are written to demo/out/${file}.`, `return { json: ${objectOf(columns)} };`);
}

// 5. Emails: what would have been sent.
for (const name of ['Duplicate Alert', 'Success Notification', 'Review Notification', 'Admin Alert Email']) {
  const p = byName(name).parameters;
  toCode(
    name,
    'shows the email it would send; nothing is sent.',
    `return { json: { sent: false, to: ${js(p.sendTo)}, subject: ${js(p.subject)}, html: ${js(p.html ?? p.message ?? '')} } };`
  );
}

// 6. Google Drive: a month folder that "exists", and files that are "filed" there.
for (const name of ['Search Folder', 'Search Duplicate Folder']) {
  toCode(name, 'pretends this month’s folder exists in Google Drive.', `return { json: { id: 'demo-folder', name: new Date().toISOString().substring(0, 7) } };`);
}
for (const name of ['Create Folder', 'Create Dup Folder']) {
  toCode(name, 'would create the month folder in Google Drive.', `return { json: { id: 'demo-folder' } };`);
}
for (const name of ['Move File', 'Upload Attachment', 'Move Dup File', 'Upload Dup Attachment']) {
  toCode(name, 'shows where the file would be filed in Google Drive.', `return { json: { filed: false, file: $('detectFileType').item.json.pdf_filename, folder: 'demo-folder' } };`);
}

// 7. Write the sheet rows to CSV files so a run leaves something to inspect.
function csvWriter(after, file, dx, dy) {
  const at = byName(after).position;
  const convert = {
    id: `demo-csv-${file}`,
    name: `${file} (demo)`,
    type: 'n8n-nodes-base.convertToFile',
    typeVersion: 1.1,
    position: [at[0] + dx, at[1] + dy],
    parameters: { operation: 'csv', options: { fileName: file } },
  };
  const write = {
    id: `demo-write-${file}`,
    name: `Write ${file}`,
    type: 'n8n-nodes-base.readWriteFile',
    typeVersion: 1,
    position: [at[0] + dx + 220, at[1] + dy],
    parameters: { operation: 'write', fileName: `/demo/out/${file}`, options: {} },
    notes: `Demo mode: demo/out/${file}`,
    notesInFlow: true,
  };
  wf.nodes.push(convert, write);
  const outs = (wf.connections[after] ??= { main: [[]] }).main;
  outs[0].push({ node: convert.name, type: 'main', index: 0 });
  wf.connections[convert.name] = { main: [[{ node: write.name, type: 'main', index: 0 }]] };
}
csvWriter('Google Sheets Append', 'ledger.csv', 0, -220);
csvWriter('Audit Log', 'audit-log.csv', 0, 180);

wf.name = 'LedgerQuarry (demo mode)';
wf.id = 'LedgerQuarryDemo';
wf.active = false;
wf.settings = { ...(wf.settings || {}), executionOrder: 'v1' };

const out = JSON.stringify(wf, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const current = readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n');
  if (current !== out) {
    console.error('workflows/demo-workflow.json is out of date: run node scripts/build-demo-workflow.mjs');
    process.exit(1);
  }
  console.log('demo-workflow.json is up to date');
} else {
  writeFileSync(TARGET, out);
  console.log(`wrote workflows/demo-workflow.json (${wf.nodes.length} nodes)`);
}
