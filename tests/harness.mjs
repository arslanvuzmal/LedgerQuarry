// Runs a Code node from workflows/workflow.json the way n8n does, so the tests exercise the code
// that actually ships rather than a copy of it.
//   "Run Once for All Items": $input.all() and `this.helpers`, returns the items.
//   "Run Once for Each Item": $input.item and `item`, returns the item.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKFLOW = fileURLToPath(new URL('../workflows/workflow.json', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// n8n runs the code inside its own function, so a node may redeclare `item` or `items`.
const wrap = (code) => `return (async () => {
${code}
}).call(this);`;

export function loadWorkflow(path = WORKFLOW) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function codeOf(name, workflow = loadWorkflow()) {
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`No node called "${name}"`);
  return { code: node.parameters.jsCode, mode: node.parameters.mode || 'runOnceForAllItems' };
}

/** Deep copy so a test's input is never mutated by the node under test. */
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Run a Code node on items ({ json, binary? }). Binary buffers are passed as
 * `binary.<key>.buffer` and served through this.helpers.getBinaryDataBuffer.
 */
export async function runNode(name, items, workflow) {
  const { code, mode } = codeOf(name, workflow);
  const buffers = items.map((it) => Object.fromEntries(Object.entries(it.binary || {}).map(([k, b]) => [k, b.buffer])));
  const prepared = items.map((it) => ({
    json: clone(it.json),
    binary: it.binary
      ? Object.fromEntries(Object.entries(it.binary).map(([k, b]) => [k, { mimeType: b.mimeType, fileName: b.fileName }]))
      : undefined,
  }));
  const helpers = { getBinaryDataBuffer: async (i, key) => buffers[i][key] };
  if (mode === 'runOnceForEachItem') {
    const fn = new AsyncFunction('$input', 'item', '$json', wrap(code));
    const out = [];
    for (const it of prepared) out.push(await fn.call({ helpers }, { item: it }, it, it.json));
    return out;
  }
  const fn = new AsyncFunction('$input', 'items', wrap(code));
  return fn.call({ helpers }, { all: () => prepared, first: () => prepared[0] }, prepared);
}

/** A Claude-shaped extraction value. */
export const v = (value, confidence = 95) => ({ value, confidence });
