// A fake Decisions transport for tests. It answers every question it is sent, records each
// call, and never touches the network. Pass `fake.transport` wherever a transport is accepted
// (askLuna, createEngine({ transport })).
//
//   const fake = fakeLuna({
//     predicates: { need_retrieval: 0.9, c0: 0.8 },          // or (name, state) => p
//     choices: { model: { 'claude-haiku-5-5': 0.7, 'claude-sonnet-5-5': 0.3 } },
//     scores: { effort: [0.1, 0.6, 0.3, 0, 0] },            // level order
//     fail: new Error('boom'),                              // every call throws
//     usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1100 } },
//   });
//   fake.calls -> [{ state, questions }]

/** One predicate answer. */
export function predicate(name, probability) {
  return { type: 'predicate', name, probability };
}

/** One choice answer; `probs` maps value -> probability (the highest is the choice). */
export function choice(name, probs, confidence) {
  const entries = Object.entries(probs);
  const [best] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  return {
    type: 'choice', name, choice: best,
    probabilities: entries.map(([value, probability]) => ({ value, probability })),
    ...(confidence != null ? { confidence } : {}),
  };
}

/** One score answer with a level distribution (by position) and optional confidence. */
export function score(name, probs, confidence) {
  const s = probs.reduce((a, p, i) => a + p * i, 0);
  return {
    type: 'score', name, score: s,
    probabilities: probs.map((probability, value) => ({ value, probability })),
    ...(confidence != null ? { confidence } : {}),
  };
}

function uniform(n) {
  return Array.from({ length: n }, () => 1 / n);
}

/**
 * @param {{predicates?:object|Function, choices?:object|Function, scores?:object|Function,
 *   fail?:Error, usage?:object, refuse?:string[]}} [spec]
 */
export function fakeLuna(spec = {}) {
  const calls = [];
  const pick = (table, name, state) => (typeof table === 'function' ? table(name, state) : table?.[name]);

  async function transport(opts, state, questions) {
    calls.push({ opts, state, questions });
    if (spec.fail) throw spec.fail;
    const answers = questions.map((q) => {
      if (spec.refuse?.includes(q.name)) return { type: 'refusal', name: q.name };
      if (q.type === 'predicate') return predicate(q.name, pick(spec.predicates, q.name, state) ?? 0.5);
      if (q.type === 'score') return score(q.name, pick(spec.scores, q.name, state) ?? uniform(q.levels.length), pick(spec.confidences, q.name, state));
      const values = q.choices.map((c) => c.value);
      const given = pick(spec.choices, q.name, state);
      const probs = typeof given === 'string'
        ? Object.fromEntries(values.map((v) => [v, v === given ? 0.9 : 0.1 / (values.length - 1)]))
        : given ?? Object.fromEntries(values.map((v) => [v, 1 / values.length]));
      return choice(q.name, probs, pick(spec.confidences, q.name, state));
    });
    return { answers, usage: spec.usage ?? { input_tokens: 1000, input_tokens_details: { cached_tokens: 900 } } };
  }
  return { transport, calls };
}
