// The SKILL.md catalog: scans skill folders for <dir>/<skill>/SKILL.md (one level deep) and reads
// the YAML front matter of each file. The subset understood is what skills need: `key: value`
// lines whose value is plain, single-quoted or double-quoted, or a `>` (folded) or `|` (literal)
// block of indented lines. Other YAML is ignored, never guessed. See docs/design.md §4.2.
import fs from 'node:fs';
import path from 'node:path';

/** The file that describes a skill, inside its own folder. */
export const SKILL_FILE = 'SKILL.md';
const FENCE = '---';
const BOM = /^\uFEFF/;
const KEY_LINE = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/;
const BLOCK_HEADER = /^[>|][+\-\d]*$/;
const INDENTED = /^[ \t]/;
const DOUBLE_QUOTED = /^"((?:[^"\\]|\\.)*)"/;
const SINGLE_QUOTED = /^'((?:[^']|'')*)'/;
const COMMENT = /(^|\s)#.*$/;
const LEADING_INDENT = /^[ \t]*/;

/** The lines between the opening and the closing `---` fence; [] without a closed front matter. */
function frontMatterLines(text) {
  const lines = String(text ?? '').replace(BOM, '').split(/\r?\n/);
  if (lines[0].trimEnd() !== FENCE) return [];
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === FENCE);
  return end < 0 ? [] : lines.slice(1, end);
}

/** A quoted scalar on one line, or null when the value is not quoted. */
function unquote(head) {
  const doubled = DOUBLE_QUOTED.exec(head);
  if (doubled) return { value: doubled[1].replace(/\\(["\\])/g, '$1'), consumed: 0 };
  const single = SINGLE_QUOTED.exec(head);
  if (single) return { value: single[1].replace(/''/g, "'"), consumed: 0 };
  return null;
}

/** A plain scalar: a trailing comment is dropped and indented lines after it continue it. */
function readPlain(head, lines, from) {
  const value = head.replace(COMMENT, '').trim();
  if (!value) return { value, consumed: 0 };
  let text = value;
  let consumed = 0;
  while (from + consumed < lines.length && INDENTED.test(lines[from + consumed]) && lines[from + consumed].trim()) {
    text += ` ${lines[from + consumed].trim()}`;
    consumed += 1;
  }
  return { value: text, consumed };
}

/** `>`: consecutive lines join with a space; a blank line ends a paragraph. */
function foldLines(body) {
  const paragraphs = [];
  let words = [];
  for (const line of [...body, '']) {
    if (line.trim()) {
      words.push(line.trim());
    } else if (words.length) {
      paragraphs.push(words.join(' '));
      words = [];
    }
  }
  return paragraphs.join('\n');
}

/** `|`: lines kept as written, with the common indentation removed. */
function literalLines(body) {
  const indents = body.filter((l) => l.trim()).map((l) => LEADING_INDENT.exec(l)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return body.map((l) => (l.trim() ? l.slice(cut) : '')).join('\n');
}

/** A `>` or `|` block: the indented and blank lines after its key. */
function readBlock(style, lines, from) {
  let consumed = 0;
  while (from + consumed < lines.length && (!lines[from + consumed].trim() || INDENTED.test(lines[from + consumed]))) {
    consumed += 1;
  }
  const body = lines.slice(from, from + consumed);
  const value = (style === '>' ? foldLines(body) : literalLines(body)).trim();
  return { value, consumed };
}

/** The value after a `key:` and how many following lines it used. */
function readValue(raw, lines, from) {
  const head = raw.trim();
  if (BLOCK_HEADER.test(head)) return readBlock(head[0], lines, from);
  return unquote(head) ?? readPlain(head, lines, from);
}

/**
 * The `key: value` fields of a file's YAML front matter, as strings. The first occurrence of a
 * key wins; nested (indented) lines are not fields; text without a closed front matter gives {}.
 * @param {string} text the whole file
 * @returns {Record<string, string>}
 */
export function parseFrontMatter(text) {
  const lines = frontMatterLines(text);
  const fields = new Map();
  let i = 0;
  while (i < lines.length) {
    const m = KEY_LINE.exec(lines[i]);
    i += 1;
    if (!m) continue;
    const { value, consumed } = readValue(m[2] ?? '', lines, i);
    i += consumed;
    if (!fields.has(m[1])) fields.set(m[1], value);
  }
  return Object.fromEntries(fields);
}

/** One skill from `<dir>/<folder>/SKILL.md`, or null when that folder has no such file. */
function readSkill(dir, folder) {
  const file = path.join(dir, folder, SKILL_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw new Error(`loadCatalog: cannot read ${file}: ${err.message}`, { cause: err });
  }
  const fields = parseFrontMatter(text);
  const name = String(fields.name ?? '').trim() || folder;
  return Object.freeze({
    name,
    description: String(fields.description ?? '').trim(),
    path: path.resolve(file),
  });
}

/** The skills one folder holds, in folder-name order; a missing folder holds none. */
function scanDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new TypeError('loadCatalog: each dir must be a non-empty string');
  let folders;
  try {
    folders = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`loadCatalog: cannot read ${dir}: ${err.message}`, { cause: err });
  }
  return folders.toSorted().map((folder) => readSkill(dir, folder)).filter(Boolean);
}

function byNameAscending(a, b) {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/**
 * Scans each folder in `dirs`, in order, for `<dir>/<skill>/SKILL.md`. A missing folder is
 * skipped. A skill without a name in its front matter takes its folder name. When two folders
 * give the same name, the first folder's skill is kept.
 * @param {string[]} dirs
 * @returns {ReadonlyArray<{name:string, description:string, path:string}>} sorted by name
 */
export function loadCatalog(dirs) {
  if (!Array.isArray(dirs)) throw new TypeError('loadCatalog: dirs must be an array of folder paths');
  const byName = new Map();
  for (const dir of dirs) {
    for (const skill of scanDir(dir)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort(byNameAscending);
}
