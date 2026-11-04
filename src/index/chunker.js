// Line-window chunking for the repository index (docs/design.md §4.3). A file becomes windows of
// `chunkLines` lines that overlap by `chunkOverlap` lines; the last window ends at the final line.
// Ids are `relPath#startLine`; lines are 1-based and inclusive; paths are posix; CRLF is accepted
// and chunk text is written back with LF.
import { DEFAULTS } from '../defaults.js';

const LINE_BREAK = /\r?\n/;
const BOM = /^﻿/;
const BACKSLASH = /\\/g;
const LEADING_DOT_SLASH = /^(?:\.\/)+/;

/**
 * Throws TypeError unless the window size and overlap are usable: chunkLines is a positive
 * integer and chunkOverlap an integer from 0 to chunkLines - 1 (so every window advances).
 * @param {{chunkLines:number, chunkOverlap:number}} opts
 */
export function assertChunkOptions({ chunkLines, chunkOverlap }) {
  if (!Number.isInteger(chunkLines) || chunkLines < 1) throw new TypeError('chunk: chunkLines must be a positive integer');
  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkLines) {
    throw new TypeError('chunk: chunkOverlap must be an integer from 0 to chunkLines - 1');
  }
}

/** Posix form of a relative path: forward slashes, no leading "./". */
function posixPath(relPath) {
  return relPath.replace(BACKSLASH, '/').replace(LEADING_DOT_SLASH, '');
}

/** [start, end) index ranges of the windows over `count` lines; the last one ends at `count`. */
function windowRanges(count, size, overlap) {
  const step = size - overlap;
  const ranges = [];
  for (let start = 0; ; start += step) {
    const end = Math.min(start + size, count);
    ranges.push([start, end]);
    if (end === count) return ranges;
  }
}

/**
 * Cuts a text file into overlapping line windows.
 * @param {string} relPath path relative to the repository root (either slash style)
 * @param {string} text the file content
 * @param {{chunkLines?:number, chunkOverlap?:number}} [opts] defaults: the retrieve config values
 * @returns {ReadonlyArray<{id:string, source:string, startLine:number, endLine:number, text:string}>}
 *   an empty array for an empty or whitespace-only file
 * @throws {TypeError} on a bad path, text or window options
 */
export function chunkFile(relPath, text, {
  chunkLines = DEFAULTS.retrieve.chunkLines,
  chunkOverlap = DEFAULTS.retrieve.chunkOverlap,
} = {}) {
  assertChunkOptions({ chunkLines, chunkOverlap });
  if (typeof relPath !== 'string' || !relPath.trim()) throw new TypeError('chunk: relPath must be a non-empty string');
  if (typeof text !== 'string') throw new TypeError('chunk: text must be a string');
  const source = posixPath(relPath);
  if (!source) throw new TypeError('chunk: relPath must name a file');
  if (!text.trim()) return [];
  const lines = text.replace(BOM, '').split(LINE_BREAK);
  if (lines.at(-1) === '') lines.pop();
  return windowRanges(lines.length, chunkLines, chunkOverlap).map(([start, end]) => Object.freeze({
    id: `${source}#${start + 1}`,
    source,
    startLine: start + 1,
    endLine: end,
    text: lines.slice(start, end).join('\n'),
  }));
}
