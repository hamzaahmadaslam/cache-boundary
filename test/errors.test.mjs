import { answers } from "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { planChecks, runChecks } from "../src/check.mjs";
import { fixtureFetch, JevError } from "../src/jev.mjs";

// One saved page that code cannot decide, so every run is exactly one request.
const plan = planChecks([
  {
    kind: "saved",
    input: "article.html",
    label: "article.html",
    url: "https://example.com/article/",
    path: "/article/",
    status: 200,
    headers: { "content-type": "text/html", "cache-control": "public, max-age=600" },
    hasHeaders: true,
    setCookieNames: [],
    body: "<html><head><title>An article</title></head><body><p>Words about cotton.</p></body></html>",
    truncated: false,
    redirects: [],
    second: null,
  },
]);

const jevError = (status, message) => (error) =>
  error instanceof JevError && error.status === status && (message instanceof RegExp ? message.test(error.message) : error.message === message);

test("the plan holds one request, and a good answer gives a verdict", async () => {
  assert.equal(plan.requests.length, 1);
  const { fetchImpl, calls } = fixtureFetch(() => answers());
  const result = await runChecks(plan, { apiKey: "test-key", fetchImpl });
  assert.equal(result.summary.cache, 1);
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0].headers.authorization, "Bearer test-key");
  assert.deepEqual(Object.keys(calls[0].body), ["model", "state", "questions"]);
});

test("a missing key is a plain error, and no request is made", async () => {
  const { fetchImpl, calls } = fixtureFetch(() => answers());
  for (const apiKey of ["", "   "]) {
    await assert.rejects(runChecks(plan, { apiKey, fetchImpl }), jevError(0, /^TYPESAFE_API_KEY is not set\./));
  }
  assert.equal(calls.length, 0);
});

test("401 and 422 stop the run at once with a plain message", async () => {
  const refused = fixtureFetch(() => 401);
  await assert.rejects(runChecks(plan, { apiKey: "test-key", fetchImpl: refused.fetchImpl }), jevError(401, "TypeSafe error: the API key was refused"));
  assert.equal(refused.calls.length, 1);
  const invalid = fixtureFetch(() => 422);
  await assert.rejects(
    runChecks(plan, { apiKey: "test-key", fetchImpl: invalid.fetchImpl }),
    jevError(422, 'TypeSafe error: the request was invalid: {"error":"fixture"}'),
  );
  assert.equal(invalid.calls.length, 1);
});

test("429 and 529 are retried with backoff, then succeed or stop with a plain message", async () => {
  const limited = fixtureFetch((body, call) => (call === 1 ? 429 : answers()));
  const result = await runChecks(plan, { apiKey: "test-key", fetchImpl: limited.fetchImpl, retries: 1 });
  assert.equal(limited.calls.length, 2);
  assert.equal(result.summary.cache, 1);
  const busy = fixtureFetch(() => 529);
  await assert.rejects(
    runChecks(plan, { apiKey: "test-key", fetchImpl: busy.fetchImpl, retries: 1 }),
    jevError(529, "TypeSafe error: TypeSafe is overloaded; try again later"),
  );
  assert.equal(busy.calls.length, 2);
});

test("a request that takes too long stops with a plain timeout message", async () => {
  let calls = 0;
  // A slow server: it would answer after five seconds, which also keeps the event loop alive the way a socket does.
  const hanging = (url, init) => {
    calls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify(answers()))), 5_000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      });
    });
  };
  await assert.rejects(
    runChecks(plan, { apiKey: "test-key", fetchImpl: hanging, timeoutSeconds: 0.05, retries: 0 }),
    jevError(0, "Could not reach TypeSafe: timed out"),
  );
  assert.equal(calls, 1);
});

test("an answer that is not JSON, or that holds no answers, stops the run with a plain message", async () => {
  const gateway = async () => new Response("<html><body>Bad gateway</body></html>", { status: 200, headers: { "content-type": "text/html" } });
  await assert.rejects(runChecks(plan, { apiKey: "test-key", fetchImpl: gateway }), jevError(200, "TypeSafe answered with something other than JSON."));
  const empty = fixtureFetch(() => ({ model: "jev-1.13.0", answers: null, usage: {} }));
  await assert.rejects(runChecks(plan, { apiKey: "test-key", fetchImpl: empty.fetchImpl }), jevError(200, "TypeSafe answered without answers."));
});

test("a malformed answer sends the route to review instead of guessing", async () => {
  const { fetchImpl } = fixtureFetch(() => ({ model: "jev-1.13.0", answers: { visitor_content: { type: "noul", noul: 0.1 } }, usage: {} }));
  const result = await runChecks(plan, { apiKey: "test-key", fetchImpl });
  assert.deepEqual(
    result.results.map((r) => [r.verdict, r.reasons]),
    [["review", ["no_answer"]]],
  );
});
