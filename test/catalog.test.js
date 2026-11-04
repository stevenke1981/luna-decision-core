import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, parseFrontMatter } from '../src/skills/catalog.js';

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-catalog-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeSkill(root, folder, text) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
}

test('parseFrontMatter reads plain, double-quoted and single-quoted values', () => {
  const text = [
    '---',
    'name: plain-name',
    'description: "Says \\"hi\\" and C:\\\\path"',
    "license: 'it''s MIT'",
    '---',
    'body',
  ].join('\n');
  assert.deepEqual(parseFrontMatter(text), {
    name: 'plain-name',
    description: 'Says "hi" and C:\\path',
    license: "it's MIT",
  });
});

test('parseFrontMatter drops trailing comments and ignores everything after the closing fence', () => {
  const text = '---\nname: tdd # the workflow\ndescription: Write C# code # a note\n# a whole-line comment\n---\nname: body-name\n';
  assert.deepEqual(parseFrontMatter(text), { name: 'tdd', description: 'Write C# code' });
});

test('parseFrontMatter folds > blocks into paragraphs and keeps | blocks literal', () => {
  const text = [
    '---',
    'description: >',
    '  Use when the task',
    '  touches the parser.',
    '',
    '  Also for lexers.',
    'name: |',
    '    line one',
    '      indented two',
    '---',
  ].join('\n');
  assert.deepEqual(parseFrontMatter(text), {
    description: 'Use when the task touches the parser.\nAlso for lexers.',
    name: 'line one\n  indented two',
  });
});

test('parseFrontMatter tolerates a BOM and CRLF, and gives {} without a closed front matter', () => {
  assert.deepEqual(parseFrontMatter('\uFEFF---\r\nname: crlf\r\ndescription: "ok"\r\n---\r\nbody'), { name: 'crlf', description: 'ok' });
  assert.deepEqual(parseFrontMatter('# Just a heading\nname: not-front-matter'), {});
  assert.deepEqual(parseFrontMatter('---\nname: never closed\n'), {});
  assert.deepEqual(parseFrontMatter(''), {});
});

test('parseFrontMatter continues an indented plain value, skips nested keys, keeps the first repeat', () => {
  const text = '---\ndescription: Use for parser\n  work and lexers.\nmetadata:\n  description: nested, ignored\nname: first\nname: second\n---';
  assert.deepEqual(parseFrontMatter(text), {
    description: 'Use for parser work and lexers.',
    metadata: '',
    name: 'first',
  });
});

test('loadCatalog scans one folder level, reads name and description, sorts by name, gives absolute paths', () => {
  withTmp((root) => {
    writeSkill(root, 'zeta', '---\nname: zeta\ndescription: last one\n---\n');
    writeSkill(root, 'alpha', '---\nname: alpha\ndescription: "first one"\n---\n');
    writeSkill(root, 'nested/deep', '---\nname: deep\n---\n');
    fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: top\n---\n');
    const skills = loadCatalog([root]);
    assert.deepEqual(skills.map((s) => s.name), ['alpha', 'zeta']);
    assert.equal(skills[0].description, 'first one');
    assert.equal(skills[0].path, path.resolve(root, 'alpha', 'SKILL.md'));
    assert.ok(Object.isFrozen(skills[0]));
  });
});

test('loadCatalog takes the folder name when the front matter gives none', () => {
  withTmp((root) => {
    writeSkill(root, 'no-front', '# Just markdown\n');
    writeSkill(root, 'blank-name', '---\nname:\ndescription: has a desc\n---\n');
    assert.deepEqual(loadCatalog([root]), [
      { name: 'blank-name', description: 'has a desc', path: path.resolve(root, 'blank-name', 'SKILL.md') },
      { name: 'no-front', description: '', path: path.resolve(root, 'no-front', 'SKILL.md') },
    ]);
  });
});

test('loadCatalog skips missing folders and folders without SKILL.md', () => {
  withTmp((root) => {
    writeSkill(root, 'real', '---\nname: real\n---\n');
    fs.mkdirSync(path.join(root, 'empty'));
    fs.writeFileSync(path.join(root, 'stray.txt'), 'not a skill');
    assert.deepEqual(loadCatalog([path.join(root, 'missing'), root]).map((s) => s.name), ['real']);
    assert.deepEqual(loadCatalog([]), []);
  });
});

test('loadCatalog keeps the first dir\'s skill when two dirs give the same name', () => {
  withTmp((root) => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    writeSkill(a, 'x', '---\nname: shared\ndescription: from a\n---\n');
    writeSkill(b, 'y', '---\nname: shared\ndescription: from b\n---\n');
    writeSkill(b, 'z', '---\nname: other\n---\n');
    assert.deepEqual(loadCatalog([a, b]).map((s) => [s.name, s.description]), [['other', ''], ['shared', 'from a']]);
    assert.deepEqual(loadCatalog([b, a]).map((s) => [s.name, s.description]), [['other', ''], ['shared', 'from b']]);
  });
});

test('loadCatalog rejects a dirs value that is not an array of folder paths', () => {
  assert.throws(() => loadCatalog('skills'), /dirs must be an array/);
  assert.throws(() => loadCatalog([42]), TypeError);
  assert.throws(() => loadCatalog(['']), /non-empty string/);
});

test('loadCatalog reports a SKILL.md or a dir it cannot read instead of skipping it', () => {
  withTmp((root) => {
    fs.mkdirSync(path.join(root, 'broken', 'SKILL.md'), { recursive: true });
    assert.throws(() => loadCatalog([root]), /loadCatalog: cannot read .*SKILL\.md/);
    const file = path.join(root, 'plain.txt');
    fs.writeFileSync(file, 'a file, not a folder');
    assert.throws(() => loadCatalog([file]), /loadCatalog: cannot read/);
  });
});
