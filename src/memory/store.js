// The memory store (docs/design.md §4.4): one JSON record per line of a JSONL file. Every call
// re-reads the file, so another store or process on the same file always sees the latest
// records. Writes go to a temp file in the same folder that is renamed over the file, so a crash
// never leaves a half-written store. A line that cannot be read is skipped and reported in
// `warnings`; the next write keeps only the valid records. A text that looks like a secret
// (contract SECRET) is refused on the way in and skipped on the way out.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_TYPES } from '../defaults.js';
import { SECRET } from '../contract.js';
import { createBm25 } from '../text.js';

const ID_PATTERN = /^m_[0-9a-f]{10}$/;
const ID_BYTES = 5; // 5 random bytes, written as 10 hex characters
const DEFAULT_SOURCE = 'user';
const DEFAULT_K = 10;
const SECRET_REFUSAL = 'memory: refusing to store a text that looks like a secret';
const STRING_FIELDS = ['source', 'created', 'updated'];

const copy = (record) => ({ ...record });

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function requireObject(v, what) {
  if (!isObject(v)) throw new TypeError(`memory: ${what} needs an object`);
  return v;
}

function requireType(type) {
  if (!MEMORY_TYPES.includes(type)) throw new TypeError(`memory: type must be ${MEMORY_TYPES.join('|')}; got "${type}"`);
  return type;
}

function requireSource(source) {
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('memory: source must be a non-empty string');
  return source.trim();
}

/** The text, trimmed. Throws TypeError unless it is non-empty, and Error when it is a secret. */
function checkedText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('memory: text must be a non-empty string');
  const clean = text.trim();
  if (SECRET.test(clean)) throw new Error(SECRET_REFUSAL);
  return clean;
}

/** The changed fields of an update, each checked. */
function patchOf(patch) {
  const p = requireObject(patch, 'update');
  const changes = {};
  if (p.text !== undefined) changes.text = checkedText(p.text);
  if (p.type !== undefined) changes.type = requireType(p.type);
  return changes;
}

/** Why a parsed line is not a valid record, or null when it is. Never echoes the text. */
function recordProblem(obj) {
  if (!isObject(obj)) return 'not an object';
  if (typeof obj.id !== 'string' || !ID_PATTERN.test(obj.id)) return 'bad id';
  if (!MEMORY_TYPES.includes(obj.type)) return 'bad type';
  if (typeof obj.text !== 'string' || !obj.text.trim()) return 'empty text';
  if (STRING_FIELDS.some((k) => typeof obj[k] !== 'string')) return 'missing source, created or updated';
  if (SECRET.test(obj.text)) return 'text looks like a secret; skipped';
  return null;
}

function toRecord(obj) {
  return { id: obj.id, type: obj.type, text: obj.text, source: obj.source, created: obj.created, updated: obj.updated };
}

// JSON.parse errors quote the line, which may hold a secret, so the parser's message is not kept.
function parseLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return { problem: 'not JSON' };
  }
  const problem = recordProblem(obj);
  return problem ? { problem } : { record: toRecord(obj) };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw new Error(`memory: cannot read ${file}: ${err.message}`);
  }
}

/** The valid records in file order, and a warning for each line that was skipped. */
function readRecords(file) {
  const records = [];
  const warnings = [];
  const ids = new Set();
  readText(file).replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const { record, problem } = parseLine(line);
    const duplicate = record && ids.has(record.id);
    if (problem || duplicate) {
      warnings.push({ line: i + 1, error: problem ?? `duplicate id ${record.id}` });
    } else {
      ids.add(record.id);
      records.push(record);
    }
  });
  return { records, warnings };
}

/** Writes the records to a temp file beside `file`, then renames it over `file`. */
function writeRecords(file, records) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const body = records.map((r) => `${JSON.stringify(r)}\n`).join('');
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (cleanupErr) {
      throw new Error(`memory: write failed (${err.message}); temp file ${tmp} could not be removed (${cleanupErr.message})`);
    }
    throw err;
  }
}

function newId(records) {
  const taken = new Set(records.map((r) => r.id));
  let id;
  do {
    id = `m_${crypto.randomBytes(ID_BYTES).toString('hex')}`;
  } while (taken.has(id));
  return id;
}

/** BM25 over the records' text, best first, each with its score. */
function searchRecords(records, query, k) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const hits = createBm25(records.map(({ id, text }) => ({ id, text }))).search(query, k);
  return hits.map(({ id, score }) => ({ ...copy(byId.get(id)), score }));
}

/**
 * A memory store over the JSONL file `file`. The file and its folder are created on the first
 * write; a missing file reads as empty.
 * @param {string} file
 * @param {{now?: () => Date}} [options] clock for the created/updated timestamps
 * @returns {Readonly<{warnings: {line:number, error:string}[], list(): object[], get(id: string): object|null,
 *   search(query: string, k?: number): (object & {score:number})[], add(input: {type:string, text:string, source?:string}): object,
 *   update(id: string, patch: {text?:string, type?:string}): object, remove(id: string): boolean}>}
 */
export function createMemoryStore(file, { now = () => new Date() } = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('memory: file must be a non-empty path');
  if (typeof now !== 'function') throw new TypeError('memory: now must be a function');
  const load = () => readRecords(file);
  const stamp = () => now().toISOString();

  return Object.freeze({
    /** Lines skipped by the latest read of the file. */
    get warnings() {
      return load().warnings.map(copy);
    },
    /** Every valid record, as copies. */
    list() {
      return load().records.map(copy);
    },
    /** The record with this id, as a copy, or null. */
    get(id) {
      const found = load().records.find((r) => r.id === id);
      return found ? copy(found) : null;
    },
    /** The records that best match `query`, with their BM25 score; at most `k`. */
    search(query, k = DEFAULT_K) {
      if (typeof query !== 'string') throw new TypeError('memory: query must be a string');
      if (!Number.isInteger(k) || k < 1) throw new TypeError('memory: k must be a positive integer');
      return searchRecords(load().records, query, k);
    },
    /** Stores a new record and returns it. Refuses a secret text and an unknown type. */
    add(input) {
      const { type, text, source = DEFAULT_SOURCE } = requireObject(input, 'add');
      const fields = { type: requireType(type), text: checkedText(text), source: requireSource(source) };
      const { records } = load();
      const at = stamp();
      const record = { id: newId(records), ...fields, created: at, updated: at };
      writeRecords(file, [...records, record]);
      return copy(record);
    },
    /** Changes the text and/or type of a record and bumps `updated`. Unknown id: Error. */
    update(id, patch) {
      const changes = patchOf(patch ?? {});
      const { records } = load();
      const index = records.findIndex((r) => r.id === id);
      if (index < 0) throw new Error(`memory: unknown id "${id}"`);
      const next = { ...records[index], ...changes, updated: stamp() };
      writeRecords(file, records.map((r, i) => (i === index ? next : r)));
      return copy(next);
    },
    /** Removes a record; false when no record has this id (the file is then left alone). */
    remove(id) {
      const { records } = load();
      if (!records.some((r) => r.id === id)) return false;
      writeRecords(file, records.filter((r) => r.id !== id));
      return true;
    },
  });
}
