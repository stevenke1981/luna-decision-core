import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { diagnose, formatDiagnostics } from '../src/diagnostics.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-doctor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    config(overrides = {}, env = {}) {
      return loadConfig({ env: { LUNA_CORE_HOME: path.join(dir, 'state'), ...env }, cwd: dir, overrides });
    },
  };
}

test('local diagnostics report missing, non-directory and readable configured folders without creating paths', (t) => {
  const f = fixture(t);
  const folder = path.join(f.dir, 'skills');
  const file = path.join(f.dir, 'a-file');
  const missing = path.join(f.dir, 'missing');
  fs.mkdirSync(folder);
  fs.writeFileSync(file, 'not a directory');
  const config = f.config({ mode: 'heuristic', skills: { dirs: [folder, file, missing] } });
  const before = fs.readdirSync(f.dir);
  const report = diagnose(config);
  const statuses = report.checks.filter((check) => check.id.startsWith('skills-')).map((check) => check.status);
  assert.deepEqual(statuses, ['pass', 'fail', 'warn']);
  assert.equal(report.ok, false);
  assert.deepEqual(report.retrievalRoots, [f.dir]);
  assert.deepEqual(fs.readdirSync(f.dir), before);
});

test('doctor warns about the default Claude targets without confusing the Luna model with a generation target', (t) => {
  const f = fixture(t);
  const report = diagnose(f.config({ mode: 'heuristic' }));
  assert.equal(report.decisionModel.model, 'gpt-6-luna');
  assert.ok(report.generationModels.every((model) => model.id.startsWith('claude-')));
  const note = report.checks.find((check) => check.id === 'claude-candidates');
  assert.match(note.action, /route.models/);
  assert.match(formatDiagnostics(report), /availability not checked/);
  const custom = diagnose(f.config({ mode: 'heuristic', route: { models: [{
    id: 'host-configured-model', tier: 1, contextWindow: 8192, efforts: ['low'],
  }] } }));
  assert.equal(custom.checks.some((check) => check.id === 'claude-candidates'), false);
});

test('doctor reports unsupported runtimes as local failures and never labels live checks as passed', (t) => {
  const f = fixture(t);
  const old = diagnose(f.config({ mode: 'heuristic' }), { node: '22.14.0', platform: 'test', arch: 'test' });
  assert.equal(old.ok, false);
  assert.equal(old.checks.find((check) => check.id === 'node').status, 'fail');
  assert.equal(old.decisionModel.liveCheck, 'not_run');
  const supported = diagnose(f.config({ mode: 'heuristic' }), { node: '22.15.0' });
  assert.equal(supported.checks.find((check) => check.id === 'node').status, 'pass');
});

test('doctor removes endpoint query values and literal credentials from structured and text output', (t) => {
  const f = fixture(t);
  const key = 'sk-test-only-abcdefghijklmnopqrstuvwxyz123456';
  const proxySecret = 'opaque-proxy-value';
  const config = f.config({ luna: { url: `https://example.invalid/decisions?opaque=${proxySecret}`, model: key } }, { OPENAI_API_KEY: key });
  const report = diagnose(config);
  const json = JSON.stringify(report);
  const text = formatDiagnostics(report);
  for (const output of [json, text]) {
    assert.ok(!output.includes(key));
    assert.ok(!output.includes(proxySecret));
  }
  assert.equal(report.decisionModel.apiKey, 'set');
  assert.equal(report.decisionModel.endpoint, 'https://example.invalid/decisions?[redacted]');
  assert.equal(report.decisionModel.liveCheck, 'not_run');
});
