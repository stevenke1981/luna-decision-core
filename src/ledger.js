// The decision ledger (docs/design.md §5): one JSON line per decision in a JSONL file. Only the
// fields in LEDGER_FIELDS are written, so a decision's `result`, `reasons`, and the task, query,
// observation or segments never reach the file. `summary` is the kind's one-line digest of its
// result; a kind must keep input text out of it. A write is a synchronous append. A failure is
// reported to stderr once and then ignored, so a full disk never fails a decision.
import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_FIELDS = Object.freeze(['kind', 'source', 'confidence', 'cost', 'tokens', 'calls', 'latencyMs', 'error', 'summary']);

/**
 * The record written for a decision: a timestamp and the whitelisted fields, absent ones null.
 * @param {object} decision
 * @param {Date} [now]
 * @returns {object}
 */
export function ledgerRecord(decision, now = new Date()) {
  const record = { ts: now.toISOString() };
  for (const field of LEDGER_FIELDS) record[field] = decision[field] ?? null;
  return record;
}

/**
 * @param {{path: string, enabled?: boolean}} options `path` is required when enabled
 * @returns {Readonly<{append: (decision: object) => void}>}
 */
export function createLedger({ path: file, enabled = true }) {
  if (enabled && typeof file !== 'string') throw new TypeError('createLedger: path must be a string when the ledger is enabled');
  let warned = false;
  return Object.freeze({
    append(decision) {
      if (!enabled) return;
      const line = `${JSON.stringify(ledgerRecord(decision))}\n`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line, 'utf8');
      } catch (err) {
        if (warned) return;
        warned = true;
        process.stderr.write(`luna-core: decision ledger not written to ${file}: ${err.message}\n`);
      }
    },
  });
}
