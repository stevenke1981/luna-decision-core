import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { startHttp } from '../src/server/http.js';
import { createMcpServer } from '../src/server/mcp.js';
import { main } from '../src/cli.js';
import { fakeLuna } from './helpers/fakeLuna.js';

const readExample = (name) => JSON.parse(fs.readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8'));
const profile = readExample('codex.config.json');
const fixture = readExample('codex-route.json');
const [sol, astra] = fixture.availableModels.map((model) => model.id);
const generation = (id, model, effort, outcome = 'failure') => ({ attemptId: id, model, effort, outcome });
const [first, second] = fixture.attempts;
const raised = generation('turn-3', sol, 'high');
const wrongSteps = Array.from({ length: 6 }, () => ({ kind: 'verify', command: 'test', failed: true }));
const pick = ({ result }) => [result.model, result.effort];

function setup(t, mode = 'auto') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-routing-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'luna-core.config.json');
  fs.writeFileSync(file, JSON.stringify({ ...profile, mode, ledger: { enabled: false } }));
  const env = { LUNA_CORE_HOME: cwd };
  const config = loadConfig({ file, cwd, env });
  const fake = fakeLuna();
  return { cwd, env, config, fake, engine: createEngine({ config, transport: fake.transport }) };
}

test('generation policy is monotonic and ignores tool failures and pending attempts', async (t) => {
  const { engine, fake } = setup(t);
  const pending = generation('pending', sol, 'medium', 'pending');
  const success = generation('success', astra, 'high', 'success');
  for (const [attempts, expected] of [
    [[], [sol, 'medium']],
    [[first, pending], [sol, 'medium']],
    [[first, pending, second], [sol, 'high']],
    [[first, second, raised], [astra, 'high']],
    [[first, second, raised, success], [sol, 'medium']],
  ]) {
    assert.deepEqual(pick(await engine.route({ ...fixture, attempts, steps: wrongSteps })), expected);
  }
  assert.equal(fake.calls.length, 0);
  await assert.rejects(engine.route({ ...fixture, attempts: [first, first] }), /attemptId must be unique/);
});

test('runtime capabilities exclude missing models and disallow weaker promotions', async (t) => {
  const { engine } = setup(t);
  const attempts = [first, second, raised];
  const noAstra = [{ id: sol, efforts: ['medium', 'high'] }];
  const weakAstra = [...noAstra, { id: astra, efforts: ['medium'] }];
  for (const availableModels of [noAstra, weakAstra]) {
    await assert.rejects(engine.route({ ...fixture, attempts, availableModels }), { code: 'ESCALATION_EXHAUSTED' });
  }
  await assert.rejects(engine.route({ ...fixture, availableModels: [] }), { code: 'NO_ELIGIBLE_MODEL' });
  const onlyAstra = [{ id: astra, efforts: ['high'] }];
  assert.deepEqual(pick(await engine.route({ ...fixture, attempts: [], availableModels: onlyAstra })), [astra, 'high']);
  const highFloor = [generation('1', sol, 'xhigh'), generation('2', sol, 'xhigh')];
  await assert.rejects(engine.route({ ...fixture, attempts: highFloor, availableModels: weakAstra }),
    { code: 'ESCALATION_EXHAUSTED' });
});

async function mcpRoute(engine, fixture) {
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = '';
  output.on('data', (chunk) => { raw += chunk; });
  const done = createMcpServer({ engine, input, output }).run();
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'luna_route', arguments: fixture,
  } }) + '\n');
  await done;
  const { result } = JSON.parse(raw);
  return { ...JSON.parse(result.content[0].text), isError: result.isError };
}

test('the same route input produces matching SDK, HTTP, MCP and CLI results and error codes', async (t) => {
  const { config, engine, cwd, env } = setup(t, 'heuristic');
  const server = await startHttp({ config, engine, port: 0, log: () => {} });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const post = (input) => fetch(`http://127.0.0.1:${server.address().port}/v1/decide/route`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  async function cli(input) {
    fs.writeFileSync(path.join(cwd, 'route.json'), JSON.stringify(input));
    let stdout = '';
    let stderr = '';
    const exit = await main(['route', '--input-json', 'route.json'], {
      cwd, env, stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } },
    });
    return { exit, stdout, stderr };
  }

  const expected = pick(await engine.route(fixture));
  assert.deepEqual(expected, [sol, 'high']);
  assert.deepEqual(pick(await (await post(fixture)).json()), expected);
  assert.deepEqual(pick(await mcpRoute(engine, fixture)), expected);
  const good = await cli(fixture);
  assert.equal(good.exit, 0);
  assert.deepEqual(pick(JSON.parse(good.stdout)), expected);

  const exhausted = { ...fixture, attempts: [first, second, raised], availableModels: [fixture.availableModels[0]] };
  const response = await post(exhausted);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).errorCode, 'ESCALATION_EXHAUSTED');
  const mcpError = await mcpRoute(engine, exhausted);
  assert.equal(mcpError.isError, true);
  assert.equal(mcpError.errorCode, 'ESCALATION_EXHAUSTED');
  const cliError = await cli(exhausted);
  assert.equal(cliError.exit, 1);
  assert.match(cliError.stderr, /\[ESCALATION_EXHAUSTED\]/);
});
