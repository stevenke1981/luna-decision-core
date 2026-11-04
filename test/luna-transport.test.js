import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { askLuna, postDecision, requestBody, resetLunaState, validateQuestions } from '../src/luna/client.js';

const P = (name) => ({ type: 'predicate', name, instructions: `Is ${name} true?` });
const answer = (name, probability = 0.8) => ({ type: 'predicate', name, probability });
const success = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ answers: [answer('ok')], usage: { input_tokens: 10 } }));
};

async function withServer(handler, fn) {
  resetLunaState();
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const opts = { url: `http://127.0.0.1:${server.address().port}/v1/decisions`, apiKey: 'test-key', model: 'gpt-6-luna', timeoutMs: 2000, cacheMode: 'off' };
  try {
    return await fn(opts);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    resetLunaState();
  }
}

test('cache off explicitly disables implicit caching and never marks a breakpoint', () => {
  const off = requestBody('gpt-6-luna', {}, [P('ok')], 'off');
  assert.deepEqual(off.prompt_cache_options, { mode: 'explicit' });
  assert.equal(off.prompt_cache_key, undefined);
  assert.equal(off.input[0].content[0].prompt_cache_breakpoint, undefined);
  const implicit = requestBody('gpt-6-luna', {}, [P('ok')], 'implicit');
  assert.equal(implicit.prompt_cache_options, undefined);
  assert.equal(implicit.input[0].content[0].prompt_cache_breakpoint, undefined);
});

test('an explicit-cache rejection is isolated by endpoint, model, key, organization and project', async () => {
  const seen = [];
  await withServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const body = JSON.parse(text);
      const explicit = body.prompt_cache_options?.mode === 'explicit';
      seen.push(explicit);
      const baseline = req.url === '/v1/decisions' && body.model === 'gpt-6-luna'
        && req.headers.authorization === 'Bearer test-key' && !req.headers['openai-organization'] && !req.headers['openai-project'];
      if (baseline && explicit) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"explicit cache not supported"}}');
      } else success(res);
    });
  }, async (base) => {
    const opts = { ...base, cacheMode: 'explicit' };
    await postDecision(opts, {}, [P('ok')]);
    await postDecision(opts, {}, [P('ok')]);
    const variants = [
      { url: `${opts.url}/other` }, { model: 'other-model' }, { apiKey: 'other-test-key' },
      { organization: 'other-org' }, { project: 'other-project' },
    ];
    for (const extra of variants) await postDecision({ ...opts, ...extra }, {}, [P('ok')]);
    assert.deepEqual(seen, [true, false, false, true, true, true, true, true]);
  });
});

test('cache off never retries with implicit caching when a server rejects its control', async () => {
  let hits = 0;
  await withServer((req, res) => {
    req.resume();
    hits++;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"cache control is unsupported"}}');
  }, async (opts) => {
    await assert.rejects(postDecision(opts, {}, [P('ok')]), /HTTP 400/);
    assert.equal(hits, 1);
  });
});

test('a stalled response body throws TimeoutError and pauses before the next request', async () => {
  let hits = 0;
  await withServer((req, res) => {
    req.resume();
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    res.write('{"answers":');
  }, async (base) => {
    const opts = { ...base, timeoutMs: 200 };
    await assert.rejects(postDecision(opts, {}, [P('ok')]), (err) => err.name === 'TimeoutError' && /reading the response body/.test(err.message));
    await assert.rejects(postDecision(opts, {}, [P('ok')]), /paused for 30 s/);
    assert.equal(hits, 1);
  });
});

test('a successful response with invalid JSON stops batching without exposing its raw body', async () => {
  let hits = 0;
  await withServer((req, res) => {
    req.resume();
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('not JSON: test-key');
  }, async (opts) => {
    await assert.rejects(askLuna({ ...opts, maxQuestionsPerCall: 1 }, {}, [P('q0'), P('q1')]), (err) => {
      assert.match(err.message, /invalid JSON \(HTTP 200\)/);
      assert.ok(!err.message.includes(opts.apiKey));
      return true;
    });
    assert.equal(hits, 1);
  });
});

test('HTTP-date Retry-After survives a non-JSON error body and prevents another call', async () => {
  let hits = 0;
  await withServer((req, res) => {
    req.resume();
    hits++;
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': new Date(Date.now() + 120000).toUTCString() });
    res.end('rate limit test-key');
  }, async (opts) => {
    await assert.rejects(postDecision(opts, {}, [P('ok')]), /HTTP 429: no error body/);
    await assert.rejects(postDecision(opts, {}, [P('ok')]), (err) => {
      const seconds = Number(/paused for (\d+) s/.exec(err.message)?.[1]);
      return seconds > 110 && seconds <= 120;
    });
    assert.equal(hits, 1);
  });
});

test('an expired Retry-After date permits a later caller to try again without automatic retries', async () => {
  let hits = 0;
  await withServer((req, res) => {
    req.resume();
    hits++;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' });
    res.end('{"error":{"message":"rate limit"}}');
  }, async (opts) => {
    await assert.rejects(postDecision(opts, {}, [P('ok')]), /HTTP 429/);
    assert.equal(hits, 1);
    await assert.rejects(postDecision(opts, {}, [P('ok')]), /HTTP 429/);
    assert.equal(hits, 2);
  });
});

test('authentication pauses are scoped to the account headers as well as endpoint and key', async () => {
  let hits = 0;
  await withServer((req, res) => {
    req.resume();
    hits++;
    if (req.headers.authorization === 'Bearer test-key' && !req.headers['openai-organization'] && !req.headers['openai-project']) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"not authorized"}}');
    } else success(res);
  }, async (opts) => {
    await assert.rejects(postDecision(opts, {}, [P('ok')]), /HTTP 401/);
    for (const extra of [{ apiKey: 'other-key' }, { organization: 'other-org' }, { project: 'other-project' }]) {
      await postDecision({ ...opts, ...extra }, {}, [P('ok')]);
    }
    await assert.rejects(postDecision(opts, {}, [P('ok')]), /paused/);
    assert.equal(hits, 4);
  });
});

test('an older in-flight success does not erase a newer rate-limit pause', async () => {
  let hits = 0;
  let pendingResponse;
  let signalArrival;
  const arrived = new Promise((resolve) => { signalArrival = resolve; });
  await withServer((req, res) => {
    req.resume();
    hits++;
    if (hits === 1) {
      pendingResponse = res;
      signalArrival();
    } else {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
      res.end('{"error":{"message":"slow down"}}');
    }
  }, async (opts) => {
    const first = postDecision(opts, {}, [P('ok')]);
    await arrived;
    await assert.rejects(postDecision(opts, {}, [P('ok')]), /HTTP 429/);
    success(pendingResponse);
    await first;
    await assert.rejects(postDecision(opts, {}, [P('ok')]), /paused for 7 s/);
    assert.equal(hits, 2);
  });
});

test('a cache negotiation retry respects a concurrent rate-limit pause', async () => {
  let hits = 0;
  let pendingResponse;
  let signalArrival;
  const arrived = new Promise((resolve) => { signalArrival = resolve; });
  await withServer((req, res) => {
    req.resume();
    hits++;
    if (hits === 1) {
      pendingResponse = res;
      signalArrival();
    } else if (hits === 2) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      res.end('{"error":{"message":"slow down"}}');
    } else success(res);
  }, async (base) => {
    const opts = { ...base, cacheMode: 'explicit' };
    const first = postDecision(opts, {}, [P('ok')]).catch((err) => err);
    await arrived;
    await assert.rejects(postDecision(opts, {}, [P('ok')]), /HTTP 429/);
    pendingResponse.writeHead(400, { 'content-type': 'application/json' });
    pendingResponse.end('{"error":{"message":"explicit cache unsupported"}}');
    const result = await first;
    assert.equal(hits, 2, 'the implicit-cache retry must not reach the server during the pause');
    assert.ok(result instanceof Error);
    assert.match(result.message, /paused for 30 s/);
    await assert.rejects(postDecision(opts, {}, [P('ok')]), /paused for 30 s/);
    assert.equal(hits, 2);
  });
});

test('an incomplete, duplicated, extra, mistyped, refused or invalid answer stops later batches', async () => {
  const cases = [
    { body: {}, error: /no answers array/ },
    { body: { answers: [] }, error: /no predicate answer for "q0"/ },
    { body: { answers: [answer('q0'), answer('q0')] }, error: /duplicate answers/ },
    { body: { answers: [answer('q0'), answer('extra')] }, error: /unexpected answer/ },
    { body: { answers: [{ type: 'choice', name: 'q0', choice: 'yes' }] }, error: /no predicate answer/ },
    { body: { answers: [{ type: 'refusal', name: 'q0' }] }, error: /refused "q0"/ },
    { body: { answers: [answer('q0', 2)] }, error: /no probability/ },
  ];
  for (const { body, error } of cases) {
    let calls = 0;
    const transport = async () => { calls++; return body; };
    await assert.rejects(askLuna({ maxQuestionsPerCall: 1 }, {}, [P('q0'), P('q1'), P('q2')], transport), error);
    assert.equal(calls, 1);
  }
});

test('a malformed score distribution in an early batch stops later requests', async () => {
  let calls = 0;
  const questions = [
    { type: 'score', name: 'effort', instructions: 'How much effort?', levels: [{ label: 'low' }, { label: 'high' }] },
    P('later'),
  ];
  const transport = async () => {
    calls++;
    return { answers: [{ type: 'score', name: 'effort', score: 1, probabilities: [0, 0.01], confidence: 1 }] };
  };
  await assert.rejects(askLuna({ maxQuestionsPerCall: 1 }, {}, questions, transport), /sum to 1/);
  assert.equal(calls, 1);
});

test('invalid batch sizes and question values are rejected before transport', async () => {
  let calls = 0;
  const transport = async () => { calls++; return { answers: [answer('ok')] }; };
  for (const maxQuestionsPerCall of [0, -1, 1.5, NaN, Infinity, '2', 401]) {
    await assert.rejects(askLuna({ maxQuestionsPerCall }, {}, [P('ok')], transport), /maxQuestionsPerCall/);
  }
  const invalid = [
    { ...P('ok'), name: false },
    { type: 'choice', name: 'c', instructions: 'Choose', choices: [{ value: 1 }, { value: 2 }] },
    { type: 'choice', name: 'c', instructions: 'Choose', choices: {} },
    { type: 'score', name: 's', instructions: 'Score', levels: [{ label: 'low' }, {}] },
  ];
  for (const question of invalid) await assert.rejects(askLuna({}, {}, [question], transport));
  assert.equal(calls, 0);
  validateQuestions([{ type: 'choice', name: 'c', instructions: 'Choose', choices: [{ value: false }, { value: 'false' }] }]);
});

test('postDecision also validates direct callers before any HTTP request', async () => {
  let hits = 0;
  await withServer((req, res) => { hits++; req.resume(); success(res); }, async (opts) => {
    await assert.rejects(postDecision(opts, {}, []), /no questions/);
    const tooMany = Array.from({ length: 401 }, (_, i) => P(`q${i}`));
    await assert.rejects(postDecision(opts, {}, tooMany), /at most 400/);
    assert.equal(hits, 0);
  });
});
