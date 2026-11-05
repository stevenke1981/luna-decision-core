import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { main } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { createEngine } from '../src/engine.js';
import { createMcpServer } from '../src/server/mcp.js';
import { startHttp } from '../src/server/http.js';

const input = { task: 'check media', control: { taskId: 'media', revision: 'r1', goal: 'Check media', acceptance: ['probe'], requiredTools: ['ffprobe'] } };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-transport-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { LUNA_CORE_HOME: home, LUNA_CORE_MODE: 'heuristic' };
  const config = loadConfig({ cwd: home, env });
  const engine = createEngine({ config, transport: () => { throw new Error('Unexpected provider call'); } });
  return { home, env, config, engine };
}
test('CLI JSON input carries the complete control contract', async (t) => {
  const f = fixture(t);
  let out = ''; let err = '';
  const code = await main(['route', '--input', '-'], {
    cwd: f.home, env: f.env, stdin: Readable.from([JSON.stringify(input)]),
    stdout: { write(s) { out += s; } }, stderr: { write(s) { err += s; } },
    transport: () => { throw new Error('Unexpected provider call'); },
  });
  assert.equal(code, 0, err);
  assert.equal(JSON.parse(out).result.control.nextAction, 'repair_tools');
});
test('MCP accepts control and rejects unknown nested fields', async (t) => {
  const f = fixture(t);
  const source = new PassThrough(); const output = new PassThrough();
  let raw = ''; output.on('data', (s) => { raw += s; });
  const server = createMcpServer({ engine: f.engine, input: source, output, log: () => {} });
  const done = server.run();
  const call = (id, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'luna_route', arguments: args } });
  source.end([call(1, input), call(2, { ...input, control: { ...input.control, surprise: true } })].map(JSON.stringify).join('\n') + '\n');
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  const byId = Object.fromEntries(raw.trim().split('\n').map(JSON.parse).map((r) => [r.id, r]));
  assert.equal(JSON.parse(byId[1].result.content[0].text).result.control.nextAction, 'repair_tools');
  assert.ok(byId[2].error || byId[2].result?.isError);
});
test('HTTP control returns a next action without executing a worker', async (t) => {
  const f = fixture(t);
  const server = await startHttp({ engine: f.engine, config: f.config, port: 0, log: () => {} });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/decide/route`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    const d = await response.json();
    assert.equal(d.result.control.nextAction, 'repair_tools'); assert.equal(d.calls, 0);
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
