// The MCP stdio server over PassThrough streams: the handshake, the six tools and their closed
// schemas, tool success and tool errors, JSON-RPC error codes, and notifications that get no
// reply. Heuristic mode or fakeLuna only; temp homes; no network and no real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { createMcpServer, PROTOCOL_VERSION } from '../src/server/mcp.js';
import { fakeLuna } from './helpers/fakeLuna.js';

const KEY = 'sk-abcdefghijklmnopqrstuvwxyz123456';
const TOOL_NAMES = ['luna_route', 'luna_skills', 'luna_retrieve', 'luna_recall', 'luna_remember', 'luna_compress'];
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function home(overrides = {}, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-mcp-'));
  const config = loadConfig({ env: { LUNA_CORE_HOME: dir, ...env }, cwd: dir, overrides: { mode: 'heuristic', ...overrides } });
  return { dir, config, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Sends `lines` (objects are stringified) to a server on PassThrough streams, ends the input and
 * waits for every reply. Returns the parsed reply lines, the raw stdout text and the log lines.
 */
async function exchange(engine, lines, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = '';
  output.on('data', (chunk) => {
    raw += chunk;
  });
  const logs = [];
  const server = createMcpServer({ engine, input, output, log: (line) => logs.push(line), ...options });
  const done = server.run();
  input.end(`${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  const replies = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { replies, raw, logs };
}

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const call = (id, name, args) => request(id, 'tools/call', { name, arguments: args });
/** The message a tool error carries (its text is JSON). */
const errorText = (reply) => JSON.parse(reply.result.content[0].text).error;

/** Every object in a schema is closed: additionalProperties false, and every property schema too. */
function assertClosed(schema, where) {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${where} must be closed`);
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(schema.properties, key), `${where}.${key} is required but not declared`);
    for (const [key, sub] of Object.entries(schema.properties)) assertClosed(sub, `${where}.${key}`);
  }
  if (schema.type === 'array' && schema.items) assertClosed(schema.items, `${where}[]`);
}

test('initialize answers the protocol version, the server info and the tools capability', async () => {
  const h = home();
  try {
    const engine = createEngine({ config: h.config });
    const { replies } = await exchange(engine, [request(1, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } })], { version: '9.9.9-test' });
    assert.equal(replies.length, 1);
    const [reply] = replies;
    assert.equal(reply.jsonrpc, '2.0');
    assert.equal(reply.id, 1);
    assert.equal(reply.result.protocolVersion, '2025-06-18');
    assert.deepEqual(reply.result.serverInfo, { name: 'luna-decision-core', version: '9.9.9-test' });
    assert.ok(reply.result.capabilities.tools);
  } finally {
    h.cleanup();
  }
});

test('tools/list names the six tools, each with a closed input schema that mirrors its kind', async () => {
  const h = home();
  try {
    const { replies } = await exchange(createEngine({ config: h.config }), [request(2, 'tools/list')]);
    const tools = replies[0].result.tools;
    assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES);
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assertClosed(tool.inputSchema, tool.name);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
    assert.deepEqual(byName.luna_route.required, ['task']);
    assert.deepEqual(Object.keys(byName.luna_route.properties).sort(), ['candidates', 'contextTokens', 'localOnly', 'requires', 'steps', 'task']);
    assert.deepEqual(byName.luna_remember.properties.source.enum, ['user', 'agent', 'tool']);
    assert.deepEqual(byName.luna_remember.properties.type.enum, ['user', 'feedback', 'project', 'reference']);
    assert.deepEqual(byName.luna_compress.required, ['window', 'segments']);
    assert.deepEqual(byName.luna_compress.properties.segments.items.required, ['id', 'role', 'text', 'turn']);
  } finally {
    h.cleanup();
  }
});

test('tools/call returns the decision as JSON text with isError false', async () => {
  const h = home();
  try {
    const engine = createEngine({ config: h.config });
    const { replies } = await exchange(engine, [call(3, 'luna_route', { task: 'rename a variable' })]);
    const [reply] = replies;
    assert.equal(reply.id, 3);
    assert.equal(reply.result.isError, false);
    assert.equal(reply.result.content.length, 1);
    assert.equal(reply.result.content[0].type, 'text');
    const decision = JSON.parse(reply.result.content[0].text);
    assert.equal(decision.kind, 'route');
    assert.equal(decision.result.model, 'claude-haiku-5-5');
  } finally {
    h.cleanup();
  }
});

test('tools/call answers every other tool in heuristic mode', async () => {
  const h = home();
  try {
    const engine = createEngine({ config: h.config });
    // Requests run concurrently, so the recall waits for the write it depends on.
    const written = await exchange(engine, [call(3, 'luna_remember', { observation: 'Remember: I prefer pnpm over npm', source: 'agent' })]);
    assert.equal(JSON.parse(written.replies[0].result.content[0].text).result.applied, true);
    const { replies } = await exchange(engine, [
      call(1, 'luna_skills', { task: 'use rust-testing', catalog: [{ name: 'rust-testing', description: 'Rust tests' }] }),
      call(2, 'luna_retrieve', { query: 'evictCache least recently used', candidates: [{ id: 'c1', source: 'cache.js', text: 'evictCache drops the least recently used entry', score: 2 }] }),
      call(4, 'luna_recall', { query: 'pnpm or npm' }),
      call(5, 'luna_compress', { window: 3000, segments: [{ id: 'a', role: 'tool', text: 'x'.repeat(9000), turn: 0 }, { id: 'b', role: 'user', text: 'now', turn: 9 }] }),
    ]);
    const byId = Object.fromEntries(replies.map((r) => [r.id, r.result]));
    const kinds = Object.fromEntries(Object.entries(byId).map(([id, r]) => [id, JSON.parse(r.content[0].text).kind]));
    assert.deepEqual(kinds, { 1: 'skills', 2: 'retrieve', 4: 'memory_recall', 5: 'compress' });
    for (const result of Object.values(byId)) assert.equal(result.isError, false);
    assert.equal(JSON.parse(byId[4].content[0].text).result.memories.length, 1);
  } finally {
    h.cleanup();
  }
});

test('an argument the closed schema does not allow is a tool error and the engine is not called', async () => {
  const h = home();
  try {
    const engine = createEngine({ config: h.config });
    const { replies } = await exchange(engine, [
      call(1, 'luna_route', { task: 'x', bogus: true }),
      call(2, 'luna_route', { task: 'x', steps: [{ kind: 'exec', command: 'npm test', failed: true, extra: 1 }] }),
      call(3, 'luna_route', { task: 'x', steps: [{ kind: 'dance', command: 'npm test' }] }),
      call(4, 'luna_route', { task: 42 }),
      call(5, 'luna_route', { task: 'x', contextTokens: -1 }),
      call(6, 'luna_recall', {}),
      call(7, 'luna_route', 'not an object'),
    ]);
    assert.equal(replies.length, 7);
    const messageOf = (id) => {
      const reply = replies.find((r) => r.id === id);
      assert.equal(reply.result.isError, true, `call ${id} must be a tool error`);
      return errorText(reply);
    };
    assert.match(messageOf(1), /arguments has an unknown field "bogus"/);
    assert.match(messageOf(2), /arguments\.steps\[0\] has an unknown field "extra"/);
    assert.match(messageOf(3), /arguments\.steps\[0\]\.kind must be one of read, edit, verify, exec, tool/);
    assert.match(messageOf(4), /arguments\.task must be string/);
    assert.match(messageOf(5), /arguments\.contextTokens must be at least 0/);
    assert.match(messageOf(6), /arguments\.query is required/);
    assert.match(messageOf(7), /arguments must be object/);
    assert.equal(engine.stats().decisions, 0);
  } finally {
    h.cleanup();
  }
});

test('a tool call the engine rejects is isError true with the message, not a protocol error', async () => {
  const h = home();
  try {
    const engine = createEngine({ config: h.config });
    const { replies } = await exchange(engine, [call(1, 'luna_route', { task: '   ' }), call(2, 'luna_route', { task: 'add a flag', localOnly: true })]);
    assert.equal(replies[0].error, undefined);
    assert.equal(replies[0].result.isError, true);
    assert.match(replies[0].result.content[0].text, /route: task must be a non-empty string/);
    assert.match(replies[1].result.content[0].text, /no eligible model/);
  } finally {
    h.cleanup();
  }
});

test('a Luna failure in strict mode is a tool error, and the key is scrubbed from it', async () => {
  const h = home({ mode: 'luna' }, { OPENAI_API_KEY: KEY });
  try {
    const fake = fakeLuna({ fail: new Error(`Luna HTTP 401: Incorrect API key provided: ${KEY}`) });
    const engine = createEngine({ config: h.config, transport: fake.transport });
    const { replies, raw } = await exchange(engine, [call(1, 'luna_route', { task: 'design a cache' })], { config: h.config });
    assert.equal(replies[0].result.isError, true);
    assert.match(replies[0].result.content[0].text, /Luna HTTP 401/);
    assert.ok(!raw.includes(KEY));
  } finally {
    h.cleanup();
  }
});

test('an unknown tool is an invalid-params error, and tools/call without an object is too', async () => {
  const h = home();
  try {
    const { replies } = await exchange(createEngine({ config: h.config }), [
      call(1, 'luna_nothing', {}),
      request(2, 'tools/call', 'oops'),
    ]);
    assert.equal(replies[0].error.code, INVALID_PARAMS);
    assert.match(replies[0].error.message, /Unknown tool: luna_nothing/);
    assert.equal(replies[1].error.code, INVALID_PARAMS);
  } finally {
    h.cleanup();
  }
});

test('an unknown method is -32601 with the request id', async () => {
  const h = home();
  try {
    const { replies } = await exchange(createEngine({ config: h.config }), [request(7, 'resources/list')]);
    assert.equal(replies[0].id, 7);
    assert.equal(replies[0].error.code, METHOD_NOT_FOUND);
    assert.match(replies[0].error.message, /resources\/list/);
  } finally {
    h.cleanup();
  }
});

test('a line that is not JSON is a parse error with a null id, and the server carries on', async () => {
  const h = home();
  try {
    const { replies } = await exchange(createEngine({ config: h.config }), ['{"jsonrpc": "2.0", "id": 1', request(2, 'ping')]);
    const parse = replies.find((r) => r.error?.code === PARSE_ERROR);
    assert.equal(parse.id, null);
    assert.equal(parse.error.message, 'Parse error');
    assert.deepEqual(replies.find((r) => r.id === 2).result, {});
  } finally {
    h.cleanup();
  }
});

test('invalid requests, batches and client replies are handled without a crash', async () => {
  const h = home();
  try {
    const { replies } = await exchange(createEngine({ config: h.config }), [
      { id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2 },
      [request(3, 'ping')],
      'null',
      { jsonrpc: '2.0', id: 4, result: { ok: true } },
      { jsonrpc: '2.0', id: 5, method: 'ping', params: [] },
      '   ',
    ]);
    const invalid = replies.filter((r) => r.error?.code === INVALID_REQUEST);
    assert.equal(invalid.length, 4);
    assert.equal(invalid.find((r) => r.id === 1).error.code, INVALID_REQUEST);
    assert.match(invalid.find((r) => r.error.message.startsWith('Batch')).error.message, /Batch requests/);
    assert.deepEqual(replies.find((r) => r.id === 5).result, {});
    assert.equal(replies.some((r) => r.id === 4), false);
  } finally {
    h.cleanup();
  }
});

test('notifications get no reply, known or unknown', async () => {
  const h = home();
  try {
    const { replies, raw } = await exchange(createEngine({ config: h.config }), [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
      { jsonrpc: '2.0', method: 'something/unknown' },
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'luna_nothing' } },
    ]);
    assert.equal(replies.length, 0);
    assert.equal(raw, '');
  } finally {
    h.cleanup();
  }
});

test('stdout carries only JSON-RPC lines, even when the engine throws during a tool call', async () => {
  const engine = {
    decide: async () => {
      throw new Error('disk on fire');
    },
    stats: () => ({}),
  };
  const { replies, raw } = await exchange(engine, [call(1, 'luna_route', { task: 'x' }), request(2, 'tools/list')]);
  for (const line of raw.split('\n').filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  assert.equal(replies.length, 2);
  assert.equal(replies.find((r) => r.id === 1).result.isError, true);
  assert.match(errorText(replies.find((r) => r.id === 1)), /disk on fire/);
});

test('a tool error message has the API key scrubbed when the config supplies it', async () => {
  const engine = {
    decide: async () => {
      throw new Error(`upstream echoed ${KEY}`);
    },
    stats: () => ({}),
  };
  const { replies, raw } = await exchange(engine, [call(1, 'luna_route', { task: 'x' })], { config: { apiKey: KEY } });
  assert.equal(replies[0].result.isError, true);
  assert.ok(!raw.includes(KEY));
  assert.match(errorText(replies[0]), /\[redacted\]/);
});

test('createMcpServer requires an engine', () => {
  assert.throws(() => createMcpServer({}), /engine is required/);
});
