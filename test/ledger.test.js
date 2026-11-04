import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger, ledgerRecord, LEDGER_FIELDS } from '../src/ledger.js';

/** A temp folder, removed afterwards. */
function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-ledger-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DECISION = {
  kind: 'route',
  source: 'luna',
  result: { model: 'claude-sonnet-5-5', task: 'PRIVATE TASK TEXT' },
  confidence: 0.9,
  reasons: ['quoted the task: PRIVATE TASK TEXT'],
  cost: 0.0001,
  tokens: { input: 1000, cached: 900 },
  calls: 1,
  latencyMs: 12,
  summary: 'route: claude-sonnet-5-5 / medium',
};

test('ledgerRecord keeps only the whitelisted fields, with a timestamp and nulls for absent ones', () => {
  const rec = ledgerRecord(DECISION, new Date('2026-11-04T00:00:00.000Z'));
  assert.equal(rec.ts, '2026-11-04T00:00:00.000Z');
  assert.deepEqual(Object.keys(rec).sort(), ['ts', ...LEDGER_FIELDS].sort());
  assert.equal(rec.error, null);
  assert.equal(rec.summary, 'route: claude-sonnet-5-5 / medium');
  assert.equal(JSON.stringify(rec).includes('PRIVATE'), false);

  const failed = ledgerRecord({ kind: 'skills', source: null, error: 'Luna HTTP 500: x' });
  assert.equal(failed.source, null);
  assert.equal(failed.calls, null);
  assert.equal(failed.error, 'Luna HTTP 500: x');
});

test('append writes one JSON line per decision, in order, creating missing folders', () => withDir((dir) => {
  const file = path.join(dir, 'nested', 'deeper', 'decisions.jsonl');
  const ledger = createLedger({ path: file, enabled: true });
  ledger.append({ ...DECISION, kind: 'route' });
  ledger.append({ ...DECISION, kind: 'compress', source: 'settled', calls: 0, cost: null });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind), ['route', 'compress']);
  assert.equal(lines[1].source, 'settled');
  assert.equal(lines[1].cost, null);
  assert.deepEqual(lines[0].tokens, { input: 1000, cached: 900 });
}));

test('a disabled ledger is a no-op, even with a path that cannot be written', () => withDir((dir) => {
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const ledger = createLedger({ path: path.join(blocker, 'decisions.jsonl'), enabled: false });
  assert.doesNotThrow(() => ledger.append(DECISION));
  const plain = createLedger({ path: path.join(dir, 'off.jsonl'), enabled: false });
  plain.append(DECISION);
  assert.equal(fs.existsSync(path.join(dir, 'off.jsonl')), false);
}));

test('a write failure is reported to stderr once and never throws', () => withDir((dir) => {
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const ledger = createLedger({ path: path.join(blocker, 'decisions.jsonl'), enabled: true });
  const original = process.stderr.write;
  const captured = [];
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    assert.doesNotThrow(() => ledger.append(DECISION));
    assert.doesNotThrow(() => ledger.append(DECISION));
    assert.doesNotThrow(() => ledger.append(DECISION));
  } finally {
    process.stderr.write = original;
  }
  assert.equal(captured.length, 1);
  assert.match(captured[0], /decision ledger not written/);
}));

test('an enabled ledger needs a path', () => {
  assert.throws(() => createLedger({ enabled: true }), (err) => err instanceof TypeError && /path must be a string/.test(err.message));
  assert.doesNotThrow(() => createLedger({ enabled: false }));
});

test('a failed decision is written with a null source and null summary', () => withDir((dir) => {
  const file = path.join(dir, 'decisions.jsonl');
  createLedger({ path: file, enabled: true }).append({
    kind: 'memory_write', source: null, result: null, reasons: [], cost: null, tokens: null, calls: 0,
    latencyMs: 3, error: 'Luna abstained', summary: null,
  });
  const [line] = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(line.source, null);
  assert.equal(line.error, 'Luna abstained');
  assert.equal(line.summary, null);
  assert.equal(line.calls, 0);
}));
