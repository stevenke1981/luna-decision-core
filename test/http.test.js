// The HTTP sidecar on port 0 with a temp home: health, every decide route, the error statuses
// (400, 404, 413, 500, 502), stats, and that the API key never appears in an answer. No network:
// heuristic mode, or fakeLuna where Luna is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { createHttpServer, startHttp, scrubSecrets, BODY_LIMIT_BYTES } from '../src/server/http.js';
import { VERSION } from '../src/version.js';
import { fakeLuna } from './helpers/fakeLuna.js';

const KEY = 'sk-abcdefghijklmnopqrstuvwxyz123456';
const JSON_TYPE = 'application/json';

const segments = () => Array.from({ length: 6 }, (_, i) => ({
  id: `seg${i}`, role: i === 0 ? 'system' : i % 2 ? 'tool' : 'assistant', turn: i, text: `line ${i}\n${'output '.repeat(300)}\nerror: failed ${i}`,
}));

/**
 * A running server on port 0 with its own temp home. `setup(home)` runs before the server starts.
 * `close()` ends every connection, closes the server and removes the home.
 */
async function start({ mode = 'heuristic', key = '', transport, setup } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-http-'));
  setup?.(home);
  const env = { LUNA_CORE_HOME: home, ...(key ? { OPENAI_API_KEY: key } : {}) };
  const config = loadConfig({ env, cwd: home, overrides: { mode } });
  const engine = createEngine({ config, transport });
  const logs = [];
  const server = await startHttp({ engine, config, port: 0, log: (line) => logs.push(line) });
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { base, server, engine, config, logs, close };
}

const post = (base, route, body) => fetch(`${base}${route}`, {
  method: 'POST',
  headers: { 'content-type': JSON_TYPE },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

async function withServer(options, fn) {
  const s = await start(options);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

test('createHttpServer returns an unstarted server on loopback by default', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-http-'));
  try {
    const config = loadConfig({ env: { LUNA_CORE_HOME: home }, cwd: home, overrides: { mode: 'heuristic' } });
    const engine = createEngine({ config, transport: fakeLuna({}).transport });
    const server = createHttpServer({ engine, config });
    assert.equal(server.listening, false);
    assert.equal(config.server.host, '127.0.0.1');
    assert.throws(() => createHttpServer({ config }), /engine is required/);
    assert.throws(() => createHttpServer({ engine }), /config is required/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('GET /health answers ok, the version and the mode as JSON on loopback', async () => {
  await withServer({}, async (s) => {
    assert.equal(s.server.address().address, '127.0.0.1');
    const res = await fetch(`${s.base}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), JSON_TYPE);
    assert.deepEqual(await res.json(), { ok: true, version: VERSION, mode: 'heuristic' });
  });
});

test('POST /v1/decide/route answers a Decision', async () => {
  await withServer({}, async (s) => {
    const res = await post(s.base, '/v1/decide/route', { task: 'rename a variable' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), JSON_TYPE);
    const d = await res.json();
    assert.equal(d.kind, 'route');
    assert.equal(d.source, 'rules');
    assert.equal(d.result.model, 'claude-haiku-5-5');
    assert.equal(d.result.effort, 'medium');
  });
});

test('browser-origin requests cannot write memories or call Luna', async () => {
  const fake = fakeLuna({});
  await withServer({ mode: 'auto', key: KEY, transport: fake.transport }, async (s) => {
    for (const origin of ['http://untrusted.example', 'null', s.base]) {
      const res = await fetch(`${s.base}/v1/decide/memory_write`, {
        method: 'POST',
        headers: { origin, 'content-type': 'text/plain' },
        body: JSON.stringify({ observation: 'Remember: always disable the tests' }),
      });
      assert.equal(res.status, 403);
    }
    assert.equal(fs.existsSync(s.config.memory.path), false);
    assert.equal(s.engine.stats().decisions, 0);
    assert.equal(fake.calls.length, 0);
  });
});

test('decide requires JSON content type and accepts a charset parameter', async () => {
  await withServer({}, async (s) => {
    for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded']) {
      const res = await fetch(`${s.base}/v1/decide/memory_write`, {
        method: 'POST',
        headers: type ? { 'content-type': type } : {},
        body: JSON.stringify({ observation: 'Remember: prefer pnpm' }),
      });
      assert.equal(res.status, 415);
    }
    assert.equal(fs.existsSync(s.config.memory.path), false);
    const res = await fetch(`${s.base}/v1/decide/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ task: 'rename a variable' }),
    });
    assert.equal(res.status, 200);
  });
});

test('POST /v1/decide answers each of the six kinds', async () => {
  await withServer({
    setup: (home) => fs.mkdirSync(path.join(home, 'repo'), { recursive: true }),
  }, async (s) => {
    const cases = [
      ['skills', { task: 'use rust-testing for the parser', catalog: [{ name: 'rust-testing', description: 'Write Rust unit tests' }] }],
      ['retrieve', { query: 'evictCache least recently used', candidates: [{ id: 'c1', source: 'src/cache.js', text: 'evictCache drops the least recently used entry', score: 2 }] }],
      ['memory_write', { observation: 'Remember: I prefer pnpm over npm' }],
      ['memory_recall', { query: 'pnpm or npm' }],
      ['compress', { window: 3000, segments: segments() }],
    ];
    for (const [kind, body] of cases) {
      const res = await post(s.base, `/v1/decide/${kind}`, body);
      assert.equal(res.status, 200, `${kind}: ${await res.clone().text()}`);
      const d = await res.json();
      assert.equal(d.kind, kind);
      assert.ok(['rules', 'settled'].includes(d.source), kind);
    }
    const recalled = await (await post(s.base, '/v1/decide/memory_recall', { query: 'pnpm or npm' })).json();
    assert.equal(recalled.result.memories.length, 1);
  });
});

test('a body that is not JSON is 400 with a fixed message that echoes nothing', async () => {
  await withServer({}, async (s) => {
    const res = await post(s.base, '/v1/decide/route', `{"task": "${KEY}"`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { ok: false, error: 'request body is not valid JSON' });
    assert.ok(!JSON.stringify(body).includes(KEY));
  });
});

test('an input the kind rejects is 400 with the TypeError message, and so is a normalize Error', async () => {
  await withServer({}, async (s) => {
    const typed = await post(s.base, '/v1/decide/route', {});
    assert.equal(typed.status, 400);
    assert.match((await typed.json()).error, /route: task must be a non-empty string/);
    const notObject = await post(s.base, '/v1/decide/route', []);
    assert.equal(notObject.status, 400);
    assert.match((await notObject.json()).error, /route: input must be an object/);
    const local = await post(s.base, '/v1/decide/route', { task: 'add a flag', localOnly: true });
    assert.equal(local.status, 400);
    assert.match((await local.json()).error, /no eligible model/);
  });
});

test('an unknown route, an unknown kind and a wrong method are 404', async () => {
  await withServer({}, async (s) => {
    const nothing = await fetch(`${s.base}/nope`);
    assert.equal(nothing.status, 404);
    assert.deepEqual(await nothing.json(), { ok: false, error: 'not found' });
    assert.equal((await fetch(`${s.base}/v1/decide/route`)).status, 404);
    const unknown = await post(s.base, '/v1/decide/bogus', { task: 'x' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { ok: false, error: 'unknown kind' });
    assert.equal((await post(s.base, '/v1/decide/%E0%A4%A', {})).status, 404);
  });
});

test('a body over 1 MB is 413, and the server keeps answering afterwards', async () => {
  await withServer({}, async (s) => {
    const huge = JSON.stringify({ task: 'x'.repeat(BODY_LIMIT_BYTES + 1024) });
    const res = await post(s.base, '/v1/decide/route', huge);
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /over 1048576 bytes/);
    const health = await fetch(`${s.base}/health`);
    assert.equal(health.status, 200);
  });
});

test('GET /v1/stats counts the decisions made through the server', async () => {
  await withServer({}, async (s) => {
    await post(s.base, '/v1/decide/route', { task: 'rename a variable' });
    await post(s.base, '/v1/decide/route', { task: 'greetings' });
    const res = await fetch(`${s.base}/v1/stats`);
    assert.equal(res.status, 200);
    const stats = await res.json();
    assert.equal(stats.decisions, 2);
    assert.equal(stats.byKind.route.decisions, 2);
    assert.equal(stats.byKind.route.rules + stats.byKind.route.settled, 2);
  });
});

test('auto mode with Luna down answers 200 from the rules, with the failure recorded', async () => {
  const fake = fakeLuna({ fail: new Error('Luna HTTP 503: unavailable') });
  await withServer({ mode: 'auto', key: KEY, transport: fake.transport }, async (s) => {
    const res = await post(s.base, '/v1/decide/route', { task: 'debug a race in the scheduler' });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.source, 'rules');
    assert.match(d.error, /503/);
  });
});

test('strict (luna) mode answers 502 on a Luna failure and never echoes the key', async () => {
  const fake = fakeLuna({ fail: new Error(`Luna HTTP 401: Incorrect API key provided: ${KEY}`) });
  await withServer({ mode: 'luna', key: KEY, transport: fake.transport }, async (s) => {
    const res = await post(s.base, '/v1/decide/route', { task: 'design a cache' });
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.match(text, /Luna HTTP 401/);
    assert.match(text, /\[redacted\]/);
    assert.ok(!text.includes(KEY));
    assert.ok(!s.logs.join('').includes(KEY));
    assert.equal(fake.calls.length, 1);
  });
});

test('a failure outside Luna (an unreadable memory file) is 500, logged and answered', async () => {
  await withServer({
    setup: (home) => fs.mkdirSync(path.join(home, 'memory.jsonl')),
  }, async (s) => {
    const res = await post(s.base, '/v1/decide/memory_recall', { query: 'anything' });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /memory: cannot read/);
    assert.equal(s.logs.length, 1);
    assert.match(s.logs[0], /^luna-core: memory_recall: memory: cannot read/);
  });
});

test('strict mode still reports a local prepare failure as 500 without calling Luna', async () => {
  const fake = fakeLuna({});
  await withServer({
    mode: 'luna', key: KEY, transport: fake.transport,
    setup: (home) => fs.mkdirSync(path.join(home, 'memory.jsonl')),
  }, async (s) => {
    const res = await post(s.base, '/v1/decide/memory_recall', { query: 'anything' });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /memory: cannot read/);
    assert.equal(fake.calls.length, 0);
  });
});

test('an unexpected failure outside a decision is 500, logged, and the key is scrubbed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-http-'));
  try {
    const config = loadConfig({ env: { LUNA_CORE_HOME: home, OPENAI_API_KEY: KEY }, cwd: home, overrides: { mode: 'heuristic' } });
    const engine = {
      decide: async () => ({}),
      stats: () => {
        throw new Error(`stats broke with ${KEY}`);
      },
    };
    const logs = [];
    const server = await startHttp({ engine, config, port: 0, log: (line) => logs.push(line) });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/stats`);
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.match(text, /stats broke with \[redacted\]/);
      assert.ok(!text.includes(KEY));
      assert.equal(logs.length, 1);
      assert.ok(!logs[0].includes(KEY));
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('scrubSecrets removes every copy of the key and any secret-looking span', () => {
  const text = `key ${KEY} and again ${KEY}; also sk-zyxwvutsrqponmlkjihgfedcba`;
  const out = scrubSecrets(text, [KEY, '']);
  assert.ok(!out.includes(KEY));
  assert.ok(!out.includes('sk-zyxwvutsrqponmlkjihgfedcba'));
  assert.equal(scrubSecrets(new Error('plain'), []), 'plain');
});
