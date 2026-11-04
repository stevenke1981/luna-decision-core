import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryStore } from '../src/memory/store.js';

const FIXED = new Date('2026-01-02T03:04:05.000Z');
const LATER = new Date('2026-01-03T00:00:00.000Z');
const ID = /^m_[0-9a-f]{10}$/;
const FILE = 'memory.jsonl';

/** Runs `fn` with a fresh folder, removed afterwards. */
function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-store-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A store over `dir/memory.jsonl` with the given clock (FIXED by default). */
function storeIn(dir, now = () => FIXED) {
  return createMemoryStore(path.join(dir, FILE), { now });
}

/** One valid stored line, as this store writes it. */
function line(id, text, type = 'user') {
  const at = FIXED.toISOString();
  return JSON.stringify({ id, type, text, source: 'user', created: at, updated: at });
}

test('add stores a record with an m_ id, its type, trimmed text, source and ISO timestamps', () => {
  withDir((dir) => {
    const store = storeIn(dir);
    const rec = store.add({ type: 'feedback', text: '  Always run the tests first  ', source: 'agent' });
    const { id, ...rest } = rec;
    assert.match(id, ID);
    assert.deepEqual(rest, {
      type: 'feedback', text: 'Always run the tests first', source: 'agent',
      created: FIXED.toISOString(), updated: FIXED.toISOString(),
    });
    assert.deepEqual(store.list(), [rec]);
  });
});

test('add defaults the source to user', () => {
  withDir((dir) => {
    assert.equal(storeIn(dir).add({ type: 'user', text: 'Works on Windows' }).source, 'user');
  });
});

test('without options the clock is the current time', () => {
  withDir((dir) => {
    const before = Date.now();
    const rec = createMemoryStore(path.join(dir, FILE)).add({ type: 'user', text: 'Clock check' });
    const at = Date.parse(rec.created);
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000);
    assert.equal(rec.updated, rec.created);
  });
});

test('list and get return copies, and get of an unknown id is null', () => {
  withDir((dir) => {
    const store = storeIn(dir);
    const rec = store.add({ type: 'user', text: 'Prefers tabs' });
    store.list()[0].text = 'changed in the copy';
    assert.equal(store.get(rec.id).text, 'Prefers tabs');
    assert.equal(store.get('m_0000000000'), null);
  });
});

test('a second store on the same file sees the first store writes (every call re-reads)', () => {
  withDir((dir) => {
    const a = storeIn(dir);
    const b = storeIn(dir);
    const rec = b.add({ type: 'user', text: 'Works in Windows' });
    assert.deepEqual(a.get(rec.id), rec);
    a.update(rec.id, { type: 'project' });
    assert.equal(b.get(rec.id).type, 'project');
  });
});

test('the file is JSON Lines: one record per line, each line ending in a newline', () => {
  withDir((dir) => {
    const store = storeIn(dir);
    store.add({ type: 'user', text: 'First fact' });
    store.add({ type: 'project', text: 'Second fact' });
    const text = fs.readFileSync(path.join(dir, FILE), 'utf8');
    assert.ok(text.endsWith('\n'));
    const parsed = text.trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((r) => r.text), ['First fact', 'Second fact']);
  });
});

test('update bumps updated, keeps id and created, and changes text and type', () => {
  withDir((dir) => {
    const rec = storeIn(dir).add({ type: 'user', text: 'Old fact' });
    const later = storeIn(dir, () => LATER);
    const next = later.update(rec.id, { text: 'New fact', type: 'project' });
    assert.equal(next.id, rec.id);
    assert.equal(next.created, rec.created);
    assert.equal(next.updated, LATER.toISOString());
    assert.equal(next.text, 'New fact');
    assert.equal(next.type, 'project');
    assert.deepEqual(later.get(rec.id), next);
    assert.equal(later.update(rec.id).text, 'New fact', 'an update with no patch changes nothing but updated');
  });
});

test('update of an unknown id throws, and update refuses a secret or a bad type without writing', () => {
  withDir((dir) => {
    const store = storeIn(dir);
    const rec = store.add({ type: 'user', text: 'Old fact' });
    assert.throws(() => store.update('m_0000000000', { text: 'x' }), /unknown id/);
    assert.throws(() => store.update(rec.id, { text: 'password: hunter2hunter2' }), /looks like a secret/);
    assert.throws(() => store.update(rec.id, { type: 'secret' }), TypeError);
    assert.equal(store.get(rec.id).text, 'Old fact');
  });
});

test('remove returns true for a stored id, false otherwise, and drops the record', () => {
  withDir((dir) => {
    const store = storeIn(dir);
    const rec = store.add({ type: 'user', text: 'Temporary note' });
    assert.equal(store.remove(rec.id), true);
    assert.equal(store.get(rec.id), null);
    assert.equal(store.remove(rec.id), false);
    assert.deepEqual(store.list(), []);
  });
});

test('search ranks by BM25 with a score, and respects k', () => {
  withDir((dir) => {
    const store = storeIn(dir);
    store.add({ type: 'project', text: 'JSONL store with atomic writes' });
    store.add({ type: 'user', text: 'Prefers tabs over spaces' });
    store.add({ type: 'reference', text: 'Atomic rename notes for Windows' });
    const hits = store.search('atomic write', 5);
    assert.equal(hits.length, 2);
    assert.ok(hits.every((h) => typeof h.score === 'number' && h.text.toLowerCase().includes('atomic')));
    assert.ok(hits[0].score >= hits[1].score);
    assert.equal(store.search('atomic', 1).length, 1);
  });
});

test('search returns nothing for stop words only or unmatched text, and rejects bad arguments', () => {
  withDir((dir) => {
    const store = storeIn(dir);
    store.add({ type: 'user', text: 'Prefers tabs over spaces' });
    assert.deepEqual(store.search('the and of'), []);
    assert.deepEqual(store.search('zebra'), []);
    assert.throws(() => store.search(5), TypeError);
    assert.throws(() => store.search('tabs', 0), TypeError);
  });
});

test('an atomic write leaves only the store file in its folder', () => {
  withDir((dir) => {
    const store = storeIn(dir);
    store.add({ type: 'user', text: 'First fact' });
    store.add({ type: 'user', text: 'Second fact' });
    assert.deepEqual(fs.readdirSync(dir), [FILE]);
  });
});

test('a failed rename removes the temp file, rethrows, and leaves no store behind', (t) => {
  withDir((dir) => {
    const store = storeIn(dir);
    t.mock.method(fs, 'renameSync', () => {
      throw new Error('rename refused');
    });
    assert.throws(() => store.add({ type: 'user', text: 'Keep me?' }), /rename refused/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('when the cleanup of a failed write also fails, the error names the temp file', (t) => {
  withDir((dir) => {
    const store = storeIn(dir);
    const realRm = fs.rmSync;
    t.mock.method(fs, 'renameSync', () => {
      throw new Error('rename refused');
    });
    t.mock.method(fs, 'rmSync', (p, o) => {
      if (String(p).endsWith('.tmp')) throw new Error('locked');
      return realRm(p, o);
    });
    assert.throws(() => store.add({ type: 'user', text: 'Stuck temp' }), /rename refused.*could not be removed \(locked\)/);
  });
});

test('writes create the missing folders (mkdir -p)', () => {
  withDir((dir) => {
    const file = path.join(dir, 'a', 'b', FILE);
    createMemoryStore(file, { now: () => FIXED }).add({ type: 'user', text: 'Nested' });
    assert.ok(fs.existsSync(file));
  });
});

test('a missing file reads as empty, without warnings, and is not created by reading', () => {
  withDir((dir) => {
    const store = storeIn(dir);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(store.warnings, []);
    assert.equal(fs.existsSync(path.join(dir, FILE)), false);
  });
});

test('a corrupt line is skipped with a warning; the next write keeps only the valid records', () => {
  withDir((dir) => {
    const file = path.join(dir, FILE);
    const bad = '{"id": broken';
    const badType = JSON.stringify({ id: 'm_cccccccccc', type: 'secret', text: 'x', source: 'user', created: 'c', updated: 'u' });
    fs.writeFileSync(file, [line('m_aaaaaaaaaa', 'One'), bad, line('m_bbbbbbbbbb', 'Two'), badType, ''].join('\n'));
    const store = createMemoryStore(file, { now: () => FIXED });
    assert.deepEqual(store.list().map((r) => r.text), ['One', 'Two']);
    assert.deepEqual(store.warnings.map((w) => w.line), [2, 4]);
    assert.ok(store.warnings.every((w) => typeof w.error === 'string' && !w.error.includes('broken')));
    store.add({ type: 'user', text: 'Three' });
    assert.deepEqual(store.warnings, []);
    assert.equal(fs.readFileSync(file, 'utf8').trimEnd().split('\n').length, 3);
  });
});

test('a duplicate id is reported and only its first line is kept', () => {
  withDir((dir) => {
    const file = path.join(dir, FILE);
    fs.writeFileSync(file, `${line('m_aaaaaaaaaa', 'One')}\n${line('m_aaaaaaaaaa', 'Again')}\n`);
    const store = createMemoryStore(file, { now: () => FIXED });
    assert.deepEqual(store.list().map((r) => r.text), ['One']);
    assert.match(store.warnings[0].error, /duplicate id/);
  });
});

test('a secret that was written into the file by hand is skipped on read, never returned', () => {
  withDir((dir) => {
    const file = path.join(dir, FILE);
    fs.writeFileSync(file, `${line('m_aaaaaaaaaa', 'token: abcdef123456')}\n${line('m_bbbbbbbbbb', 'Plain fact')}\n`);
    const store = createMemoryStore(file, { now: () => FIXED });
    assert.deepEqual(store.list().map((r) => r.id), ['m_bbbbbbbbbb']);
    assert.deepEqual(store.search('token', 5), []);
    assert.equal(store.warnings[0].error, 'text looks like a secret; skipped');
  });
});

test('add refuses a secret text and writes nothing', () => {
  withDir((dir) => {
    const store = storeIn(dir);
    assert.throws(() => store.add({ type: 'user', text: 'api_key = abcdefghijkl' }), /looks like a secret/);
    assert.throws(() => store.add({ type: 'user', text: 'sk-abcdefghijklmnopqrstuvwx' }), /looks like a secret/);
    assert.equal(fs.existsSync(path.join(dir, FILE)), false);
  });
});

test('add refuses an unknown type and an empty text with TypeError', () => {
  withDir((dir) => {
    const store = storeIn(dir);
    assert.throws(() => store.add({ type: 'secret', text: 'x' }), /type must be/);
    assert.throws(() => store.add({ type: 'user', text: '   ' }), TypeError);
    assert.throws(() => store.add(null), TypeError);
    assert.deepEqual(store.list(), []);
  });
});

test('createMemoryStore validates its file path and clock', () => {
  assert.throws(() => createMemoryStore(''), TypeError);
  assert.throws(() => createMemoryStore('memory.jsonl', { now: 'tomorrow' }), TypeError);
});

test('an unreadable store (a folder in place of the file) is an error, not an empty store', () => {
  withDir((dir) => {
    const store = createMemoryStore(dir, { now: () => FIXED });
    assert.throws(() => store.list(), /cannot read/);
  });
});
