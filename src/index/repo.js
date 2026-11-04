// Repository chunk index for the retrieve decision (docs/design.md §4.3). A synchronous walk of
// one root keeps listed text files only, cuts them into line windows and ranks the windows with
// BM25 over `source + text`. Symlinks and junctions are never followed: a link can point outside
// the root, and chunk text may be sent to Luna. Ignored folders, unlisted extensions, oversized
// files and binary files (a NUL byte in the first 8 KB) are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../defaults.js';
import { createBm25 } from '../text.js';
import { chunkFile, assertChunkOptions } from './chunker.js';

const BINARY_PROBE_BYTES = 8192;

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** The retrieve config with defaults for missing fields; throws TypeError on unusable values. */
function repoOptions(rcfg) {
  if (!isPlainObject(rcfg)) throw new TypeError('createRepoIndex: rcfg must be the retrieve config object');
  const o = { ...DEFAULTS.retrieve, ...rcfg };
  assertChunkOptions(o);
  for (const key of ['maxFileBytes', 'maxFiles']) {
    if (!Number.isInteger(o[key]) || o[key] < 1) throw new TypeError(`createRepoIndex: ${key} must be a positive integer`);
  }
  if (!Array.isArray(o.extensions) || !o.extensions.every((e) => typeof e === 'string' && e.startsWith('.'))) {
    throw new TypeError('createRepoIndex: extensions must be a list of strings starting with "."');
  }
  if (!Array.isArray(o.ignoreDirs) || !o.ignoreDirs.every((d) => typeof d === 'string')) {
    throw new TypeError('createRepoIndex: ignoreDirs must be a list of folder names');
  }
  return {
    ...o,
    extensions: new Set(o.extensions.map((e) => e.toLowerCase())),
    ignoreDirs: new Set(o.ignoreDirs),
  };
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Directory entries in name order, so the index is the same on every run. */
function readDirSorted(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort(byName);
}

/**
 * Yields { full, rel } for every listed file under `dir`, depth first, in name order. Symlinks
 * and junctions are skipped; ignored folder names are not entered.
 */
function* walkFiles(dir, rel, opts) {
  for (const entry of readDirSorted(dir)) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!opts.ignoreDirs.has(entry.name)) yield* walkFiles(full, childRel, opts);
    } else if (entry.isFile() && opts.extensions.has(path.extname(entry.name).toLowerCase())) {
      yield { full, rel: childRel };
    }
  }
}

/**
 * The file's text, or null when it is too large, binary or vanished since the walk listed it.
 * Other read errors propagate.
 */
function readIndexable(full, maxBytes) {
  const st = fs.statSync(full, { throwIfNoEntry: false });
  if (!st || st.size > maxBytes) return null;
  const buf = fs.readFileSync(full);
  if (buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
  return buf.toString('utf8');
}

/** BM25 search over the chunks; results are new objects carrying `score`. */
function searchChunks(bm25, byId, query, k) {
  if (typeof query !== 'string') throw new TypeError('search: query must be a string');
  if (!Number.isInteger(k) || k < 1) throw new TypeError('search: k must be a positive integer');
  return bm25.search(query, k).map(({ id, score }) => Object.freeze({ ...byId.get(id), score }));
}

/**
 * Indexes the text files under `root`.
 * @param {string} root the folder to index (resolved to an absolute path)
 * @param {object} rcfg the `retrieve` config section; missing fields take the defaults
 * @returns {Readonly<{search:(query:string, k?:number) => object[], files:readonly string[], chunks:readonly object[]}>}
 *   `files`: relative posix paths of the indexed files; `chunks`: every chunk; `search` returns
 *   the best `k` chunks (default: retrieve.shortlist) as new objects with a `score`.
 * @throws {TypeError} on bad arguments; {Error} when root is not a folder
 */
export function createRepoIndex(root, rcfg) {
  if (typeof root !== 'string' || !root.trim()) throw new TypeError('createRepoIndex: root must be a non-empty string');
  const opts = repoOptions(rcfg);
  const absRoot = path.resolve(root);
  if (!fs.statSync(absRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`createRepoIndex: not a folder: ${absRoot}`);
  }
  const files = [];
  const perFile = [];
  for (const { full, rel } of walkFiles(absRoot, '', opts)) {
    if (files.length >= opts.maxFiles) break;
    const text = readIndexable(full, opts.maxFileBytes);
    if (text === null) continue;
    files.push(rel);
    perFile.push(chunkFile(rel, text, opts));
  }
  const chunks = perFile.flat();
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const bm25 = createBm25(chunks.map((c) => ({ id: c.id, text: `${c.source}\n${c.text}` })));
  return Object.freeze({
    files: Object.freeze(files),
    chunks: Object.freeze(chunks),
    search: (query, k = DEFAULTS.retrieve.shortlist) => searchChunks(bm25, byId, query, k),
  });
}
