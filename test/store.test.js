import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

/** As withDir, for a callback that awaits (child processes). */
async function withDirAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-store-'));
  try {
    return await fn(dir);
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

// ------------------------------------------------ cross-process lock, rename retry, rejected lines

const WORKERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const RECORDS_PER_WORKER = 5;
const WORKER_TIMEOUT_MS = 30000;
const LOCK_WAIT_MS = 2000; // the lock wait limit in store.js
const STALE_AGE_MS = 60000; // older than the ten-second stale limit
const RENAME_ATTEMPTS = 5;
const RETRIED_CODES = ['EPERM', 'EBUSY', 'EACCES'];
// The child script: argv after -e is [storeUrl, file, label, count].
const WORKER_SCRIPT = `
  const [storeUrl, file, label, count] = process.argv.slice(1);
  const { createMemoryStore } = await import(storeUrl);
  const store = createMemoryStore(file);
  for (let i = 0; i < Number(count); i += 1) store.add({ type: 'user', text: \`worker \${label} item \${i}\` });
`;
const STORE_URL = new URL('../src/memory/store.js', import.meta.url).href;

/** Runs one child node process that adds `count` records to `file`; resolves with its outcome. */
function runWorker(file, label, count) {
  return new Promise((resolve) => {
    const args = ['--input-type=module', '-e', WORKER_SCRIPT, STORE_URL, file, label, String(count)];
    execFile(process.execPath, args, { timeout: WORKER_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({ error, stderr });
    });
  });
}

/** Sets a file's modification time to `ageMs` in the past. */
function ageFile(file, ageMs) {
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
}

/** The parsed lines of a JSONL file. */
function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
}

/** An error as a rename refusal with the given code. */
function refusal(code) {
  return Object.assign(new Error(`refused: ${code}`), { code });
}

test('six processes adding five records each to one file leave exactly thirty valid records and no error', async () => {
  await withDirAsync(async (dir) => {
    const file = path.join(dir, FILE);
    const runs = await Promise.all(WORKERS.map((label) => runWorker(file, label, RECORDS_PER_WORKER)));
    for (const { error, stderr } of runs) assert.equal(error, null, stderr);
    const store = createMemoryStore(file);
    assert.equal(store.list().length, WORKERS.length * RECORDS_PER_WORKER);
    assert.deepEqual(store.warnings, []);
    assert.equal(new Set(store.list().map((r) => r.id)).size, WORKERS.length * RECORDS_PER_WORKER);
    assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released after the last write');
  });
});

test('a lock held by another process makes a write wait, then fail, and leaves the store and the lock alone', () => {
  withDir((dir) => {
    const file = path.join(dir, FILE);
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, ''); // fresh: it stays younger than the stale limit for the whole wait
    const started = Date.now();
    assert.throws(() => storeIn(dir).add({ type: 'user', text: 'Blocked write' }), /locked by another process/);
    assert.ok(Date.now() - started >= LOCK_WAIT_MS - 100, 'the write waited before it gave up');
    assert.equal(fs.existsSync(lock), true);
    assert.equal(fs.existsSync(file), false);
  });
});

test('a lock older than ten seconds is stale: it is removed and the write goes ahead', () => {
  withDir((dir) => {
    const lock = path.join(dir, `${FILE}.lock`);
    fs.writeFileSync(lock, '');
    ageFile(lock, STALE_AGE_MS);
    const rec = storeIn(dir).add({ type: 'user', text: 'Written after a crash' });
    assert.equal(storeIn(dir).get(rec.id).text, 'Written after a crash');
    assert.equal(fs.existsSync(lock), false);
  });
});

test('a rename refused with EPERM, EBUSY or EACCES is retried, and the write then succeeds', (t) => {
  withDir((dir) => {
    const realRename = fs.renameSync;
    let calls = 0;
    t.mock.method(fs, 'renameSync', (from, to) => {
      calls += 1;
      if (calls <= RETRIED_CODES.length) throw refusal(RETRIED_CODES[calls - 1]);
      return realRename(from, to);
    });
    const rec = storeIn(dir).add({ type: 'user', text: 'Retried write' });
    assert.equal(calls, RETRIED_CODES.length + 1);
    assert.equal(storeIn(dir).get(rec.id).text, 'Retried write');
  });
});

test('a rename that keeps failing is tried five times, then rethrown, with no temp file or lock left', (t) => {
  withDir((dir) => {
    let calls = 0;
    t.mock.method(fs, 'renameSync', () => {
      calls += 1;
      throw refusal('EBUSY');
    });
    assert.throws(() => storeIn(dir).add({ type: 'user', text: 'Never lands' }), /refused: EBUSY/);
    assert.equal(calls, RENAME_ATTEMPTS);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('a rename error with another code is thrown at once, without a retry', (t) => {
  withDir((dir) => {
    let calls = 0;
    t.mock.method(fs, 'renameSync', () => {
      calls += 1;
      throw refusal('EXDEV');
    });
    assert.throws(() => storeIn(dir).add({ type: 'user', text: 'Cross device' }), /refused: EXDEV/);
    assert.equal(calls, 1);
  });
});

test('a lock file that Windows still refuses while another process deletes it (EPERM) is waited for, then taken', (t) => {
  withDir((dir) => {
    const realOpen = fs.openSync;
    let calls = 0;
    t.mock.method(fs, 'openSync', (p, flags, ...rest) => {
      if (String(p).endsWith('.lock') && flags === 'wx') {
        calls += 1;
        if (calls <= 2) throw refusal('EPERM');
      }
      return realOpen(p, flags, ...rest);
    });
    const rec = storeIn(dir).add({ type: 'user', text: 'Lock was being deleted' });
    assert.equal(calls, 3);
    assert.equal(storeIn(dir).get(rec.id).text, 'Lock was being deleted');
    assert.equal(fs.existsSync(`${path.join(dir, FILE)}.lock`), false);
  });
});

test('a lock that cannot be created for another reason is an error at once, and nothing is written', (t) => {
  withDir((dir) => {
    t.mock.method(fs, 'openSync', () => {
      throw refusal('EROFS');
    });
    assert.throws(() => storeIn(dir).add({ type: 'user', text: 'Read only' }), /cannot create lock .*refused: EROFS/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('a read refused with EBUSY is retried, so a store another process is replacing is still read', (t) => {
  withDir((dir) => {
    const file = path.join(dir, FILE);
    const rec = storeIn(dir).add({ type: 'user', text: 'Read during a rename' });
    const realRead = fs.readFileSync;
    let calls = 0;
    t.mock.method(fs, 'readFileSync', (p, ...rest) => {
      if (String(p) === file) {
        calls += 1;
        if (calls === 1) throw refusal('EBUSY');
      }
      return realRead(p, ...rest);
    });
    assert.deepEqual(storeIn(dir).list().map((r) => r.id), [rec.id]);
    assert.equal(calls, 2);
  });
});

test('lines skipped on load are appended to memory.jsonl.rejected on the next write, with line, reason and raw text', () => {
  withDir((dir) => {
    const file = path.join(dir, FILE);
    const bad = '{"id": broken';
    const badType = JSON.stringify({ id: 'm_cccccccccc', type: 'secret', text: 'x', source: 'user', created: 'c', updated: 'u' });
    const duplicate = line('m_aaaaaaaaaa', 'Again');
    fs.writeFileSync(file, [line('m_aaaaaaaaaa', 'One'), bad, line('m_bbbbbbbbbb', 'Two'), badType, duplicate, ''].join('\n'));
    const store = createMemoryStore(file, { now: () => FIXED });
    store.add({ type: 'user', text: 'Three' });
    const entries = readJsonl(`${file}.rejected`);
    assert.deepEqual(entries.map((e) => [e.line, e.error, e.raw]), [
      [2, 'not JSON', bad],
      [4, 'bad type', badType],
      [5, 'duplicate id m_aaaaaaaaaa', duplicate],
    ]);
    assert.ok(entries.every((e) => e.at === FIXED.toISOString()));
  });
});

test('a rejected line that holds a secret is recorded without its text', () => {
  withDir((dir) => {
    const file = path.join(dir, FILE);
    const leaked = '{"id":"m_aaaaaaaaaa","type":"user","text":"key sk-abcdefghijklmnopqrstuvwx"';
    const leakedRecord = line('m_bbbbbbbbbb', 'key sk-zyxwvutsrqponmlkjihgfedcba');
    fs.writeFileSync(file, [leaked, leakedRecord, line('m_cccccccccc', 'Plain')].join('\n'));
    const store = createMemoryStore(file, { now: () => FIXED });
    store.add({ type: 'user', text: 'Next' });
    const rejected = fs.readFileSync(`${file}.rejected`, 'utf8');
    assert.ok(!rejected.includes('sk-abc') && !rejected.includes('sk-zyx'), 'no secret text is written to the rejected file');
    const entries = readJsonl(`${file}.rejected`);
    assert.deepEqual(entries.map((e) => [e.line, e.error, e.raw]), [
      [1, 'not JSON', null],
      [2, 'text looks like a secret; skipped', null],
    ]);
  });
});

test('reading, and a remove that finds nothing, leave the skipped lines in place; the next real write moves them', () => {
  withDir((dir) => {
    const file = path.join(dir, FILE);
    const bad = '{"id": broken';
    const original = `${line('m_aaaaaaaaaa', 'One')}\n${bad}\n`;
    fs.writeFileSync(file, original);
    const store = createMemoryStore(file, { now: () => FIXED });
    assert.equal(store.warnings.length, 1);
    assert.equal(store.remove('m_0000000000'), false);
    assert.equal(fs.existsSync(`${file}.rejected`), false);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    store.add({ type: 'user', text: 'Two' });
    assert.deepEqual(readJsonl(`${file}.rejected`).map((e) => e.raw), [bad]);
    assert.deepEqual(store.list().map((r) => r.text), ['One', 'Two']);
  });
});
