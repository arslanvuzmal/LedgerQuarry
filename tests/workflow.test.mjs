// Tests for the deterministic steps of the invoice workflow. Each test runs the Code node's source
// from workflows/workflow.json (see harness.mjs), so a change to the workflow is a change under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNode, loadWorkflow, v } from './harness.mjs';

// An extraction as "Parse Claude Response" leaves it: success plus the parsed JSON.
function extracted(data) {
  return { json: { success: true, extracted_json: data, flags: [] } };
}
const balanced = () => ({
  invoice_number: v('INV-1001'),
  invoice_date: v('2026-10-02'),
  due_date: v('2026-11-01'),
  vendor: { name: v('Northwind Office Supplies'), address: v('12 Mill Road'), email: v('billing@northwind.example') },
  client: { name: v('Lakeside Dental') },
  line_items: [
    { description: v('Paper, A4'), quantity: v(10), unit_price: v(5.5), line_total: v(55) },
    { description: v('Toner'), quantity: v(2), unit_price: v(42.5), line_total: v(85) },
  ],
  currency: v('EUR'),
  subtotal: v(140),
  tax_amount: v(37.8),
  total: v(177.8),
  payment_terms: v('30 days'),
});

async function pipeline(data) {
  let items = [extracted(data)];
  for (const name of ['validateMath', 'validateFields', 'classifyConfidence', 'determineStatus']) {
    items = await runNode(name, items);
  }
  return items[0].json;
}

test('a balanced, confident invoice is auto-approved', async () => {
  const out = await pipeline(balanced());
  assert.deepEqual(out.mathDiscrepancies, []);
  assert.deepEqual(out.flags, []);
  assert.equal(out.avgConfidence, 95);
  assert.equal(out.status, 'AUTO_APPROVED');
});

test('line items that do not add up to the subtotal need review', async () => {
  const data = balanced();
  data.line_items[1].line_total = v(95); // 55 + 95 = 150, subtotal says 140
  const out = await pipeline(data);
  assert.ok(out.flags.includes('LINE_ITEM_SUM_MISMATCH'));
  assert.match(out.mathDiscrepancies[0], /Line items sum \(150\.00\) ≠ subtotal \(140\.00\)/);
  assert.equal(out.status, 'REVIEW_REQUIRED');
});

test('subtotal + tax must equal the total, within 0.02', async () => {
  const off = balanced();
  off.total = v(177.85);
  assert.equal((await pipeline(off)).status, 'REVIEW_REQUIRED');
  const rounding = balanced();
  rounding.total = v(177.81); // a cent of rounding is accepted
  assert.equal((await pipeline(rounding)).status, 'AUTO_APPROVED');
});

test('a missing invoice number or total needs review; a missing vendor is only flagged', async () => {
  const noNumber = balanced();
  noNumber.invoice_number = v(null, 100);
  const a = await pipeline(noNumber);
  assert.ok(a.flags.includes('MISSING_INVOICE_NUMBER'));
  assert.equal(a.status, 'REVIEW_REQUIRED');

  const noVendor = balanced();
  noVendor.vendor.name = v(null, 100);
  const b = await pipeline(noVendor);
  assert.ok(b.flags.includes('MISSING_VENDOR_NAME'));
  assert.equal(b.status, 'AUTO_APPROVED');
});

test('dates must be YYYY-MM-DD', async () => {
  const data = balanced();
  data.invoice_date = v('02/10/2026');
  assert.ok((await pipeline(data)).flags.includes('INVALID_DATE_FORMAT_INVOICE_DATE'));
});

test('a negative total is a credit note and is recommended for review', async () => {
  const data = balanced();
  data.line_items = [{ description: v('Returned toner'), quantity: v(-1), unit_price: v(42.5), line_total: v(-42.5) }];
  data.subtotal = v(-42.5);
  data.tax_amount = v(-11.48);
  data.total = v(-53.98);
  const out = await pipeline(data);
  assert.ok(out.flags.includes('CREDIT_NOTE'));
  assert.equal(out.status, 'REVIEW_RECOMMENDED');
});

test('low confidence: an average under 75, or more than two fields under 75, means review recommended', async () => {
  // 20 extracted values: 18 at 80 and 2 at 10 average 73, with only two fields under 75.
  const lowAverage = balanced();
  const setAll = (o) => { for (const val of Object.values(o)) { if (val && 'confidence' in val) val.confidence = 80; else if (val && typeof val === 'object') setAll(val); } };
  setAll(lowAverage);
  lowAverage.vendor.email.confidence = 10;
  lowAverage.payment_terms.confidence = 10;
  const a = await pipeline(lowAverage);
  assert.equal(a.avgConfidence, 73);
  assert.equal(a.lowConfidenceFields.length, 2);
  assert.equal(a.status, 'REVIEW_RECOMMENDED');

  const threeLow = balanced();
  threeLow.vendor.address.confidence = 50;
  threeLow.vendor.email.confidence = 50;
  threeLow.client.name.confidence = 50;
  const b = await pipeline(threeLow);
  assert.equal(b.lowConfidenceFields.length, 3);
  assert.ok(b.avgConfidence >= 75);
  assert.equal(b.status, 'REVIEW_RECOMMENDED');
});

test('a failed extraction is flagged as missing every required field', async () => {
  let items = [{ json: { success: false, extracted_json: null } }];
  for (const name of ['validateMath', 'validateFields', 'classifyConfidence', 'determineStatus']) items = await runNode(name, items);
  assert.deepEqual(items[0].json.flags, ['MISSING_INVOICE_NUMBER', 'MISSING_INVOICE_DATE', 'MISSING_TOTAL', 'MISSING_VENDOR_NAME']);
  assert.equal(items[0].json.status, 'REVIEW_REQUIRED');
});

test('Parse Claude Response reads the first text block, even after a thinking block', async () => {
  const answer = JSON.stringify(balanced());
  const [out] = await runNode('Parse Claude Response', [
    { json: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '```json\n' + answer + '\n```' }] } },
  ]);
  assert.equal(out.json.success, true);
  assert.equal(out.json.extracted_data.invoice_number, 'INV-1001');
  assert.equal(out.json.extracted_data.total, 177.8);
});

test('Parse Claude Response marks refusals, errors and invalid JSON as failed', async () => {
  const refusal = await runNode('Parse Claude Response', [{ json: { stop_reason: 'refusal', content: [] } }]);
  assert.equal(refusal[0].json.success, false);
  assert.equal(refusal[0].json.extracted_data.raw_response, 'REFUSED');
  const error = await runNode('Parse Claude Response', [{ json: { error: { message: 'overloaded' } } }]);
  assert.equal(error[0].json.success, false);
  const bad = await runNode('Parse Claude Response', [{ json: { content: [{ type: 'text', text: 'not json' }] } }]);
  assert.equal(bad[0].json.success, false);
  assert.match(bad[0].json.extracted_data.raw_response, /^PARSE_FAILED/);
});

test('detectFileType reads the file signature, not the extension', async () => {
  const pdf = Buffer.from('%PDF-1.4\n');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const out = await runNode('detectFileType', [
    { json: { from: 'Northwind <billing@northwind.example>' }, binary: { a: { buffer: pdf, mimeType: 'application/octet-stream', fileName: 'scan.bin' } } },
    { json: {}, binary: { a: { buffer: png, mimeType: 'image/png', fileName: 'receipt.png' } } },
    { json: {} },
  ]);
  assert.equal(out[0].json.fileType, 'pdf');
  assert.equal(out[0].json.sender_email, 'billing@northwind.example');
  assert.equal(out[1].json.fileType, 'png');
  assert.equal(out[2].json.fileType, 'unknown');
});

test('the Claude request uses a current model, leaves room for thinking, and truncates long text', async () => {
  const [out] = await runNode('Prepare Claude Multimodal Payload', [{ json: { path: 'text', text: 'x'.repeat(12000) } }]);
  const p = out.json.claude_payload;
  assert.equal(p.model, 'claude-sonnet-5-5');
  assert.ok(p.max_tokens >= 16000);
  assert.match(p.messages[0].content[0].text, /TRUNCATED DUE TO 10,000 CHAR LIMIT/);
});

test('Check Duplicate always outputs an item, so a new invoice reaches "Google Sheets Append"', () => {
  // With no matching row the Google Sheets node returns no items; without this setting the
  // workflow stopped there and new invoices were never written.
  const node = loadWorkflow().nodes.find((n) => n.name === 'Check Duplicate');
  assert.equal(node.alwaysOutputData, true);
});

// Structure: bugs found by running the workflow in n8n 2.43.8 (demo mode). Each would come back
// silently, so they are pinned here.
const workflow = () => loadWorkflow();
const nodeNamed = (name) => workflow().nodes.find((n) => n.name === name);

test('IF conditions use operations IF v1 has ("notEmpty" crashed the node)', () => {
  const ops = { string: ['contains', 'notContains', 'endsWith', 'notEndsWith', 'equal', 'notEqual', 'regex', 'notRegex', 'startsWith', 'notStartsWith', 'isEmpty', 'isNotEmpty'] };
  for (const n of workflow().nodes.filter((x) => x.type === 'n8n-nodes-base.if')) {
    for (const c of n.parameters.conditions.string || []) {
      if (c.operation !== undefined) assert.ok(ops.string.includes(c.operation), `${n.name}: ${c.operation}`);
    }
  }
});

test('failed extractions go to the error log, successful ones do not', () => {
  const node = nodeNamed('IF Success Check');
  // Must read its own input: determineStatus runs after it, on another branch.
  assert.equal(node.parameters.conditions.boolean[0].value1, '={{ $json.success }}');
  assert.equal(node.parameters.conditions.boolean[0].value2, false);
  const outs = workflow().connections['IF Success Check'].main;
  assert.equal(outs[0][0].node, 'Error Log'); // true output = success is false
  assert.equal(outs[1].length, 0);
});

test('each invoice is filed with its own file, not one paired by position', () => {
  for (const name of ['Merge Folder ID', 'Merge Dup Folder ID']) {
    const node = nodeNamed(name);
    assert.equal(node.type, 'n8n-nodes-base.code');
    assert.match(node.parameters.jsCode, /\$\('detectFileType'\)\.item/);
  }
  const fromDetect = workflow().connections.detectFileType.main[0].map((c) => c.node);
  assert.ok(!fromDetect.includes('Merge Folder ID'));
});

test('the audit log measures processing time from a value that exists', () => {
  const col = nodeNamed('Audit Log').parameters.columns.value['Processing Duration'];
  assert.doesNotMatch(col, /\$execution\.startedAt/);
  assert.match(nodeNamed('detectFileType').parameters.jsCode, /received_at/);
});
