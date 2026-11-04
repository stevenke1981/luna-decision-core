// Shared text utilities: a tokenizer that handles English and CJK, a token estimate, a small
// in-memory BM25 ranker and excerpting. Skills, retrieval and memory all rank with these, so a
// query scores the same way everywhere.

const WORD = /[\p{L}\p{N}_]+/gu;
const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/u;
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'be', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from', 'do', 'does', 'how', 'what', 'i', 'you', 'we', 'me', 'my']);

/**
 * Lower-case terms: latin words (split on camelCase and snake_case as well as kept whole) and
 * CJK character bigrams (unigrams for a lone character). Stop words are dropped.
 * @returns {string[]}
 */
export function tokenize(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(WORD)) {
    const word = m[0];
    if (CJK.test(word)) {
      const chars = [...word].filter((c) => CJK.test(c));
      if (chars.length === 1) out.push(chars[0]);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
      const latin = word.replace(new RegExp(CJK.source, 'gu'), ' ');
      out.push(...tokenize(latin));
      continue;
    }
    const lower = word.toLowerCase();
    const parts = word.split(/_|(?<=[a-z0-9])(?=[A-Z])/).map((p) => p.toLowerCase()).filter(Boolean);
    if (!STOP.has(lower) && lower.length > 1) out.push(lower);
    if (parts.length > 1) for (const p of parts) if (!STOP.has(p) && p.length > 1) out.push(p);
  }
  return out;
}

/** Rough token count: CJK characters count one each, other text one per 4 characters. */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  for (const c of s) if (CJK.test(c)) cjk++;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

/** At most `max` characters: the head, an ellipsis marker, and the tail when `keepTail`. */
export function excerpt(text, max, keepTail = false) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  if (!keepTail) return `${s.slice(0, Math.max(0, max - 1))}…`;
  const head = Math.ceil((max - 3) * 0.6);
  return `${s.slice(0, head)} … ${s.slice(s.length - (max - 3 - head))}`;
}

const K1 = 1.2;
const B = 0.75;

/**
 * BM25 over a small fixed set of documents. Immutable after construction.
 * @param {{id:string, text:string}[]} docs
 */
export function createBm25(docs) {
  const tf = docs.map((d) => {
    const counts = new Map();
    for (const t of tokenize(d.text)) counts.set(t, (counts.get(t) ?? 0) + 1);
    return counts;
  });
  const lengths = tf.map((c) => [...c.values()].reduce((a, b) => a + b, 0));
  const avg = lengths.reduce((a, b) => a + b, 0) / Math.max(1, docs.length);
  const df = new Map();
  for (const counts of tf) for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const idf = (t) => Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));

  /** Documents with a positive score, best first: [{id, score}]. */
  function search(query, k = 10) {
    const terms = [...new Set(tokenize(query))];
    const scored = [];
    for (let i = 0; i < n; i++) {
      let score = 0;
      for (const t of terms) {
        const f = tf[i].get(t);
        if (!f) continue;
        score += idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * lengths[i]) / (avg || 1))));
      }
      if (score > 0) scored.push({ id: docs[i].id, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return scored.slice(0, k);
  }
  return Object.freeze({ search, size: n });
}

/** Jaccard similarity of the term sets of two texts (0..1). */
export function similarity(a, b) {
  const x = new Set(tokenize(a));
  const y = new Set(tokenize(b));
  if (x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}
