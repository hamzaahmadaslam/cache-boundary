// Loads the routes (URLs are fetched one at a time; saved responses are read from disk), runs the checks in code,
// plans one request to Jev for each route that code could not decide, sends them, and returns the verdicts.
import { buildRules, decideRoute, DEFAULT_THRESHOLD, problemsOf, readAnswers } from "./decide.mjs";
import { FetchError, fetchPage } from "./fetch.mjs";
import { askJev, DEFAULT_MODEL } from "./jev.mjs";
import { hostsOf, pathOf, readSaved } from "./load.mjs";
import { buildRequest, REQUEST_BUDGET } from "./questions.mjs";
import { analyze } from "./signals.mjs";

export const DEFAULT_TIMEOUT_SECONDS = 10;
/** US dollars per million input tokens for jev-1.13. Output tokens are free. */
export const PRICE_PER_MILLION = 0.042;
const CONCURRENCY = 4;

async function fetchRoute(href, options) {
  const base = { kind: "fetched", input: href, label: href, second: null, redirects: [] };
  let first;
  try {
    first = await fetchPage(href, options);
  } catch (error) {
    if (error instanceof FetchError) return { ...base, error: error.message };
    throw error;
  }
  const route = {
    ...base,
    url: first.url,
    path: pathOf(first.url),
    status: first.status,
    headers: first.headers,
    hasHeaders: true,
    setCookieNames: first.setCookieNames,
    body: first.body,
    truncated: first.truncated,
    redirects: first.redirects,
  };
  if (options.twice) {
    try {
      const again = await fetchPage(href, options);
      route.second =
        again.status === first.status
          ? { body: again.body, headers: again.headers }
          : { error: `the second request got HTTP ${again.status}, the first HTTP ${first.status}` };
      route.setCookieNames = [...new Set([...route.setCookieNames, ...again.setCookieNames])];
    } catch (error) {
      if (!(error instanceof FetchError)) throw error;
      route.second = { error: error.message };
    }
  }
  return route;
}

/**
 * Loads every route: URLs in the order given (fetched as a visitor without cookies, twice with `twice`), then saved
 * responses. A URL that cannot be fetched becomes a route with an `error`; the run goes on.
 */
export async function loadRoutes({ urls, files }, options = {}) {
  const { onProgress, ...fetchOptions } = options;
  const allowedHosts = hostsOf(urls);
  const routes = [];
  let done = 0;
  for (const href of urls) {
    routes.push(await fetchRoute(href, { ...fetchOptions, allowedHosts }));
    onProgress?.(++done, urls.length);
  }
  for (const file of files) routes.push(readSaved(file));
  return routes;
}

/** Runs the checks in code on every route and builds one request for each route they could not decide. */
export function planChecks(routes, { allowCookies = [], model = DEFAULT_MODEL, twice = false } = {}) {
  const entries = routes.map((route) => {
    const analysis = analyze(route, { allowCookies });
    const entry = { analysis, request: null };
    if (analysis.status !== "checked" || !analysis.html || analysis.signals.some((s) => s.level === "block")) return entry;
    const request = buildRequest(analysis, { model, twice });
    if (request.tokens > REQUEST_BUDGET) analysis.tooLarge = true;
    else entry.request = request;
    return entry;
  });
  return { entries, requests: entries.filter((entry) => entry.request), model, twice };
}

/** Estimated input tokens and cost of a plan, for --dry-run. */
export function estimatePlan(plan) {
  const tokens = plan.requests.reduce((sum, entry) => sum + entry.request.tokens, 0);
  return { tokens, cost: (tokens * PRICE_PER_MILLION) / 1e6 };
}

/** Runs `worker` over `items` with at most `limit` at a time; stops starting new work after the first failure. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(lanes);
  return results;
}

const VERDICT_KEYS = { "do-not-cache": "do_not_cache", vary: "vary", cache: "cache", review: "review", "not-checked": "not_checked" };

/**
 * Sends the planned requests (four at a time) and returns
 * { model, threshold, results: [{ analysis, verdict, decidedBy, reasons, answer, problems }], summary, usage, rules }.
 * Any TypeSafe error (missing key, 401, 422, 429 or 529 after retries, timeout) stops the run with a JevError.
 */
export async function runChecks(plan, options = {}) {
  const {
    threshold = DEFAULT_THRESHOLD,
    apiKey,
    model = plan.model ?? DEFAULT_MODEL,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    retries = 3,
    fetchImpl,
    onProgress,
  } = options;
  let done = 0;
  const responses = await mapLimit(plan.requests, CONCURRENCY, async (entry) => {
    const { state, questions } = entry.request.body;
    const response = await askJev(state, questions, { apiKey, model, timeoutMs: timeoutSeconds * 1000, retries, fetchImpl });
    onProgress?.(++done, plan.requests.length);
    return response;
  });
  const byEntry = new Map(plan.requests.map((entry, i) => [entry, responses[i]]));
  const results = plan.entries.map((entry) => {
    const response = byEntry.get(entry);
    const answer = response ? readAnswers(response.answers) : null;
    const decision = decideRoute(entry.analysis, { asked: Boolean(entry.request), answer, threshold });
    return { analysis: entry.analysis, ...decision, answer, problems: problemsOf(entry.analysis, decision.verdict) };
  });
  const summary = { routes: results.length, do_not_cache: 0, vary: 0, cache: 0, review: 0, not_checked: 0 };
  for (const result of results) summary[VERDICT_KEYS[result.verdict]]++;
  summary.decided_in_code = results.filter((r) => r.decidedBy === "code" && r.verdict === "do-not-cache").length;
  summary.problems = results.reduce((sum, r) => sum + r.problems.length, 0);
  const usage = {
    requests: responses.length,
    input_tokens: responses.reduce((sum, r) => sum + (Number(r.usage?.input_tokens) || 0), 0),
    output_tokens: responses.reduce((sum, r) => sum + (Number(r.usage?.output_tokens) || 0), 0),
  };
  return { model: responses[0]?.model ?? model, threshold, results, summary, usage, rules: buildRules(results) };
}
