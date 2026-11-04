import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chunkFile, assertChunkOptions } from '../src/index/chunker.js';
import { createRepoIndex } from '../src/index/repo.js';
import { loadConfig } from '../src/config.js';

const numbered = (n) => Array.from({ length: n }, (_, i) => `line${i + 1}`).join('\n');

async function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-index-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cfgFor(dir, retrieve = {}) {
  return loadConfig({ env: { LUNA_CORE_HOME: dir }, cwd: dir, overrides: { retrieve } });
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

test('chunkFile windows overlap by chunkOverlap lines and the last window ends at the final line', () => {
  const chunks = chunkFile('src/a.js', numbered(10), { chunkLines: 4, chunkOverlap: 1 });
  assert.deepEqual(chunks.map((c) => [c.startLine, c.endLine]), [[1, 4], [4, 7], [7, 10]]);
  assert.deepEqual(chunks.map((c) => c.id), ['src/a.js#1', 'src/a.js#4', 'src/a.js#7']);
  assert.equal(chunks[1].text, 'line4\nline5\nline6\nline7');
  assert.equal(chunks[2].text, 'line7\nline8\nline9\nline10');
  assert.ok(chunks.every((c) => c.source === 'src/a.js' && Object.isFrozen(c)));
});

test('chunkFile numbers lines from 1, drops the final newline and never adds an empty last window', () => {
  assert.deepEqual(chunkFile('a.txt', 'one\ntwo\n', { chunkLines: 4, chunkOverlap: 0 }).map((c) => [c.id, c.text, c.endLine]), [['a.txt#1', 'one\ntwo', 2]]);
  const exact = chunkFile('b.txt', numbered(8), { chunkLines: 4, chunkOverlap: 0 });
  assert.deepEqual(exact.map((c) => [c.startLine, c.endLine]), [[1, 4], [5, 8]]);
  const single = chunkFile('c.txt', numbered(3), { chunkLines: 40, chunkOverlap: 10 });
  assert.equal(single.length, 1);
  assert.equal(single[0].endLine, 3);
  assert.equal(chunkFile('d.txt', numbered(3)).length, 1, 'the retrieve config values are the defaults');
});

test('chunkFile accepts CRLF and gives the same windows as LF with LF text', () => {
  const lf = 'a\nb\nc\nd\ne';
  const crlf = 'a\r\nb\r\nc\r\nd\r\ne\r\n';
  const opts = { chunkLines: 2, chunkOverlap: 0 };
  const fromCrlf = chunkFile('x.txt', crlf, opts);
  assert.deepEqual(fromCrlf.map((c) => [c.startLine, c.endLine]), [[1, 2], [3, 4], [5, 5]]);
  assert.deepEqual(fromCrlf, chunkFile('x.txt', lf, opts));
  assert.ok(fromCrlf.every((c) => !c.text.includes('\r')));
});

test('chunkFile returns no chunks for an empty file and writes ids with posix paths', () => {
  assert.deepEqual(chunkFile('a.js', '', { chunkLines: 4, chunkOverlap: 1 }), []);
  assert.deepEqual(chunkFile('a.js', ' \r\n\t\n', { chunkLines: 4, chunkOverlap: 1 }), []);
  assert.equal(chunkFile('src\\lib\\a.js', 'x')[0].id, 'src/lib/a.js#1');
  assert.equal(chunkFile('./top.js', 'x')[0].source, 'top.js');
  assert.equal(chunkFile(' spaced.js', 'x')[0].source, ' spaced.js', 'the name is kept as the index lists it');
});

test('chunkFile and assertChunkOptions reject bad paths, text and window options', () => {
  const type = (fn, re) => assert.throws(fn, (e) => e instanceof TypeError && re.test(e.message));
  type(() => chunkFile('', 'x'), /relPath/);
  type(() => chunkFile('a.js', 5), /text must be a string/);
  type(() => chunkFile('a.js', 'x', { chunkLines: 0 }), /chunkLines/);
  type(() => chunkFile('a.js', 'x', { chunkLines: 2.5 }), /chunkLines/);
  type(() => chunkFile('a.js', 'x', { chunkLines: 4, chunkOverlap: 4 }), /chunkOverlap/);
  type(() => chunkFile('a.js', 'x', { chunkLines: 4, chunkOverlap: -1 }), /chunkOverlap/);
  assert.doesNotThrow(() => assertChunkOptions({ chunkLines: 4, chunkOverlap: 3 }));
});

test('createRepoIndex skips ignored folders, nested ignored folders and unlisted extensions', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, {
    'src/a.js': 'const a = 1;\n',
    'src/UPPER.JS': 'const u = 2;\n',
    'src/logo.png': 'not listed\n',
    'src/deep/node_modules/x.js': 'nested ignored\n',
    'node_modules/pkg/index.js': 'ignored\n',
    '.git/hooks/pre.js': 'ignored\n',
    'dist/bundle.js': 'ignored\n',
    'docs/readme.md': '# Title\nbody\n',
    'docs/data.log': 'not listed\n',
  });
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  assert.deepEqual(index.files, ['docs/readme.md', 'src/UPPER.JS', 'src/a.js']);
  assert.ok(index.chunks.every((c) => !c.source.includes('node_modules') && !c.source.endsWith('.png')));
}));

test('createRepoIndex skips files over maxFileBytes and files with a NUL byte in the first 8 KB only', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, {
    'big.js': 'y'.repeat(25000),
    'bin.js': Buffer.from('ab\u0000cd'),
    'late-nul.js': `${'z'.repeat(9000)}\u0000tail\n`,
    'small.js': 'ok\n',
  });
  const index = createRepoIndex(repo, cfgFor(dir, { maxFileBytes: 20000 }).retrieve);
  assert.deepEqual(index.files, ['late-nul.js', 'small.js']);
}));

test('createRepoIndex stops at maxFiles and visits folders depth first in name order', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'z.js': 'z\n', 'a/x.js': 'x\n', 'b.js': 'b\n' });
  const index = createRepoIndex(repo, cfgFor(dir, { maxFiles: 2 }).retrieve);
  assert.deepEqual(index.files, ['a/x.js', 'b.js']);
  assert.ok(index.chunks.every((c) => index.files.includes(c.source)));
}));

test('createRepoIndex never follows a symlinked or junctioned folder, nor a symlinked file', () => withDir(async (dir) => {
  const outside = path.join(dir, 'outside');
  const repo = path.join(dir, 'repo');
  writeFiles(outside, { 'secret.js': 'const LEAK_MARKER = 1;\n' });
  writeFiles(repo, { 'src/a.js': 'const ok = 1;\n' });
  fs.symlinkSync(outside, path.join(repo, 'linked'), 'junction');
  fs.symlinkSync(path.join(outside, 'secret.js'), path.join(repo, 'leak.js'), 'file');
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  assert.deepEqual(index.files, ['src/a.js']);
  assert.ok(!index.chunks.some((c) => c.text.includes('LEAK_MARKER')));
}));

test('createRepoIndex windows each file with posix ids and freezes the index', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, { 'src/a.js': `${numbered(10)}\n` });
  const index = createRepoIndex(repo, cfgFor(dir, { chunkLines: 4, chunkOverlap: 1 }).retrieve);
  assert.deepEqual(index.files, ['src/a.js']);
  assert.deepEqual(index.chunks.map((c) => c.id), ['src/a.js#1', 'src/a.js#4', 'src/a.js#7']);
  assert.ok(Object.isFrozen(index) && Object.isFrozen(index.files) && Object.isFrozen(index.chunks));
}));

test('search ranks the best chunk first, matches file names too, and returns new scored objects', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  writeFiles(repo, {
    'src/cache.js': 'function cacheGet(key) {\n  return store.get(key);\n}\n// cache lookup and cache fill\n',
    'src/parse.js': 'export function parse(text) {\n  return text.trim();\n}\n',
    'src/eviction.js': 'export const limit = 10;\n',
    'docs/notes.md': 'Weekly notes about the release.\n',
  });
  const index = createRepoIndex(repo, cfgFor(dir).retrieve);
  const hits = index.search('cache lookup', 2);
  assert.equal(hits[0].id, 'src/cache.js#1');
  assert.ok(hits.length <= 2 && typeof hits[0].score === 'number' && hits[0].score > 0);
  assert.ok(Object.isFrozen(hits[0]) && !index.chunks.includes(hits[0]));
  assert.deepEqual(index.search('eviction').map((c) => c.id), ['src/eviction.js#1']);
  assert.deepEqual(index.search('zzzz'), []);
  assert.throws(() => index.search(5), TypeError);
  assert.throws(() => index.search('cache', 0), TypeError);
}));

test('createRepoIndex rejects a missing folder with an Error and bad arguments with a TypeError', () => withDir(async (dir) => {
  const type = (fn, re) => assert.throws(fn, (e) => e instanceof TypeError && re.test(e.message));
  assert.throws(() => createRepoIndex(path.join(dir, 'nope'), cfgFor(dir).retrieve), (e) => e.constructor === Error && /not a folder/.test(e.message));
  type(() => createRepoIndex('', cfgFor(dir).retrieve), /root must be a non-empty string/);
  type(() => createRepoIndex(dir, undefined), /rcfg must be the retrieve config object/);
  type(() => createRepoIndex(dir, { ...cfgFor(dir).retrieve, chunkOverlap: 40 }), /chunkOverlap/);
  type(() => createRepoIndex(dir, { ...cfgFor(dir).retrieve, extensions: ['js'] }), /extensions/);
  type(() => createRepoIndex(dir, { ...cfgFor(dir).retrieve, maxFiles: 0 }), /maxFiles/);
  type(() => createRepoIndex(dir, { ...cfgFor(dir).retrieve, ignoreDirs: 'node_modules' }), /ignoreDirs/);
}));
