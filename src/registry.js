// Kind name → kind module (docs/design.md §5). The engine imports this file lazily, only when it
// is not given `kinds`, so importing the engine loads none of the kind modules.
import { route } from './domains/route.js';
import { skills } from './domains/skills.js';
import { retrieve } from './domains/retrieve.js';
import { memoryRecall, memoryWrite } from './domains/memory.js';
import { compress } from './domains/compress.js';

/** Every kind module, keyed by the kind name used in `engine.decide(kind, input)`. */
export const KIND_MODULES = Object.freeze({
  route,
  skills,
  retrieve,
  memory_recall: memoryRecall,
  memory_write: memoryWrite,
  compress,
});
