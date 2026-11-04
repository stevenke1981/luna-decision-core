// Every tunable with its default. `config.js` merges a JSON config file and environment
// variables over this object; nothing else in the code base hard-codes these numbers.

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const MODES = ['auto', 'luna', 'heuristic'];
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
export const KINDS = ['route', 'skills', 'retrieve', 'memory_recall', 'memory_write', 'compress'];

/** The defaults; `home` is filled in by loadConfig. Plain data, deep-frozen by loadConfig. */
export const DEFAULTS = {
  // auto: ask Luna, fall back to the rules on any error or abstention.
  // luna: ask Luna, and fail the decision when Luna fails (no silent fallback).
  // heuristic: rules only; no network, no key needed.
  mode: 'auto',
  luna: {
    url: 'https://api.openai.com/v1/decisions',
    model: 'gpt-6-luna',
    timeoutMs: 4000,
    cacheMode: 'explicit',
    maxQuestionsPerCall: 16,
  },
  // Below this confidence on its headline answer Luna abstains and the rules decide.
  minConfidence: 0.4,
  // The effort ladder, least to most. A score question takes 2 to 10 levels.
  ladder: ['low', 'medium', 'high', 'xhigh', 'max'],
  route: {
    effortQuantile: 0.5,
    // Models are ordered by tier (cheap to strong); the quantile of Luna's distribution over
    // that order picks the model, so an unsure Luna does not jump to the most expensive one.
    modelQuantile: 0.5,
    // A model is eligible only when its window holds the context times this headroom.
    contextHeadroom: 1.2,
    models: [
      { id: 'claude-haiku-5-5', tier: 1, contextWindow: 200000, capabilities: ['tools', 'vision'], local: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], strengths: 'fast and cheap: lookups, routine edits, worker tasks' },
      { id: 'claude-sonnet-5-5', tier: 2, contextWindow: 200000, capabilities: ['tools', 'vision'], local: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], strengths: 'strong coder: features, focused debugging, reviews' },
      { id: 'claude-opus-5-5', tier: 3, contextWindow: 200000, capabilities: ['tools', 'vision'], local: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], strengths: 'deepest reasoning: architecture, subtle bugs, security, long multi-part work' },
    ],
  },
  skills: {
    // Folders scanned for <dir>/<skill>/SKILL.md.
    dirs: [],
    shortlist: 12,
    maxSkills: 3,
    threshold: 0.5,
  },
  retrieve: {
    // Folders a `root` may lie in (absolute paths). Empty: only the working folder of the
    // process and what lies below it. Every indexed chunk may be sent to Luna.
    allowedRoots: [],
    // A repository walk stops after this long; what was indexed so far is used.
    maxWalkMs: 5000,
    shortlist: 12,
    threshold: 0.5,
    budgetTokens: 4000,
    chunkLines: 40,
    chunkOverlap: 10,
    maxFileBytes: 1_000_000,
    maxFiles: 5000,
    excerptChars: 600,
    extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.kt', '.cs', '.c', '.h', '.cpp', '.hpp', '.rb', '.php', '.swift', '.md', '.txt', '.json', '.toml', '.yaml', '.yml', '.sh', '.ps1', '.sql', '.html', '.css'],
    ignoreDirs: ['.git', 'node_modules', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', 'coverage', '.luna-test'],
  },
  memory: {
    path: '',
    shortlist: 12,
    recallThreshold: 0.5,
    maxRecall: 5,
    durableThreshold: 0.5,
    // Jaccard similarity above which the rules treat an observation as a duplicate.
    duplicateSimilarity: 0.8,
  },
  compress: {
    // Below softRatio of the window nothing is compressed and Luna is not asked; above
    // hardRatio compaction is forced; in between Luna decides (compact_now).
    softRatio: 0.6,
    hardRatio: 0.85,
    // After compaction usage must be at or below this ratio; the rules escalate until it is.
    targetRatio: 0.5,
    keepRecentTurns: 2,
    maxSegmentsAsked: 24,
    excerptChars: 400,
    summaryChars: 400,
  },
  // The engine caches the skills catalog and repository indexes; entries older than this are
  // rebuilt, so a long-running serve or mcp sees edited files.
  cacheTtlMs: 30000,
  ledger: {
    enabled: true,
    path: '',
  },
  server: {
    host: '127.0.0.1',
    port: 8792,
  },
};
