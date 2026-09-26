import { answers, fakeSite, PUBLIC } from "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exampleFetch, SITE } from "../examples/run.mjs";
import { main, USAGE, USER_AGENT } from "../src/cli.mjs";
import { fixtureFetch } from "../src/jev.mjs";

const KEY = "test-key-never-printed";
const example = (name) => readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Runs the CLI in this process with captured output. The defaults refuse the network, so nothing can reach it. */
async function run(args, io = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    env: {},
    fetchImpl: globalThis.fetch,
    ...io,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

test("tests cannot reach the network: fetch, http, https and DNS lookups are all replaced", async () => {
  await assert.rejects(async () => globalThis.fetch("https://api.typesafe.ai/v1/systemone"), /must not use the network/);
  for (const call of [() => http.request("http://example.com/"), () => https.get("https://example.com/"), () => dns.lookup("example.com", () => {})]) {
    assert.throws(call, /must not use the network/);
  }
  await assert.rejects(async () => dns.promises.lookup("example.com"), /must not use the network/);
});

test("the example in examples/ reproduces report.txt, report.json and dry-run.txt exactly", async () => {
  const report = await run([SITE], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: exampleFetch().fetchImpl });
  assert.equal(report.code, 0);
  assert.equal(report.stdout, example("report.txt"));
  assert.equal(report.stderr, "");
  const json = await run([SITE, "--json"], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: exampleFetch().fetchImpl });
  assert.equal(json.stdout, example("report.json"));
  assert.deepEqual(JSON.parse(json.stdout).summary, {
    routes: 9,
    do_not_cache: 4,
    vary: 1,
    cache: 2,
    review: 2,
    not_checked: 0,
    decided_in_code: 3,
    problems: 0,
  });
  const dry = await run([SITE, "--dry-run"]);
  assert.equal(dry.stdout, example("dry-run.txt"));
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(readme.includes(example("report.txt")), "the README shows examples/report.txt exactly");
  for (const output of [report, json, dry]) assert.ok(!(output.stdout + output.stderr).includes(KEY), "the key is never printed");
});

test("--dry-run needs no key, sends nothing to TypeSafe, and prints every request body with --json", async () => {
  const typesafe = fixtureFetch(() => 500);
  const text = await run([SITE, "--dry-run"], { fetchImpl: typesafe.fetchImpl });
  assert.equal(text.code, 0);
  assert.match(text.stdout, /^Dry run: nothing was sent to TypeSafe\.\n/);
  assert.match(text.stdout, /6 requests to jev-latest, about [\d,]+ input tokens/);
  const json = await run([SITE, "--dry-run", "--json"], { env: { TYPESAFE_MODEL: "jev-1.13.0" }, fetchImpl: typesafe.fetchImpl });
  const data = JSON.parse(json.stdout);
  assert.equal(data.dry_run, true);
  assert.equal(data.requests.length, 6);
  assert.equal(data.requests[0].body.model, "jev-1.13.0");
  assert.deepEqual(Object.keys(data.requests[0].body.questions), ["visitor_content", "private_token", "cache_rule"]);
  assert.equal(data.estimated_input_tokens, data.requests.reduce((sum, r) => sum + r.estimated_tokens, 0));
  assert.equal(typesafe.calls.length, 0);
});

test("the report, the JSON and the dry run give token counts only: no dollar amount, no rate, no cost field", async () => {
  const report = await run([SITE], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: exampleFetch().fetchImpl });
  const json = await run([SITE, "--json"], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: exampleFetch().fetchImpl });
  const dry = await run([SITE, "--dry-run"]);
  const dryJson = await run([SITE, "--dry-run", "--json"]);
  assert.match(report.stdout, /\nModel jev-1\.13\.0, 6 requests, 4,854 input tokens, threshold 0\.8; /);
  assert.match(dry.stdout, /\n6 requests to jev-latest, about 4,854 input tokens\n/);
  for (const output of [report, dry]) assert.doesNotMatch(output.stdout, /\$|per million|\bcost/i);
  const data = JSON.parse(json.stdout);
  const plan = JSON.parse(dryJson.stdout);
  assert.deepEqual(data.usage, { requests: 6, input_tokens: 4854, output_tokens: 0 });
  for (const key of [...Object.keys(data), ...Object.keys(plan), ...Object.keys(plan.requests[0])]) {
    assert.doesNotMatch(key, /cost|usd|price/i);
  }
  const exported = [...Object.keys(await import("../src/check.mjs")), ...Object.keys(await import("../src/report.mjs"))];
  assert.deepEqual(exported.filter((name) => /price|cost|money/i.test(name)), [], "no price constant and no money formatter");
});

test("fetched URLs: leaks and cached pages that must not be cached set exit code 1; --twice catches a changing nonce", async () => {
  const html = (body, bodyClass = "page", headers = {}) => ({
    headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "public, max-age=300", ...headers },
    body: `<!doctype html><html><head><title>T</title><link rel="stylesheet" href="/wp-content/themes/t/s.css"></head><body class="${bodyClass}">${body}</body></html>`,
  });
  let nonce = 0;
  const site = fakeSite({
    "https://example.com/": html("<p>Hello Robin</p>", "home logged-in", { "x-cache": "HIT" }),
    "https://example.com/cart/": html("<p>Your cart is empty.</p>", "page woocommerce-cart", { "cf-cache-status": "HIT" }),
    "https://example.com/article/": html("<p>Words about cotton.</p>"),
    "https://example.com/form/": () => html(`<form id="f" method="post"><input type="hidden" name="_wpnonce" value="a1b2c3d4e${nonce++}"></form>`),
    "https://example.com/old/": { status: 301, headers: { location: "https://elsewhere.example.net/new/" } },
  });
  const typesafe = fixtureFetch((body) => {
    assert.equal(body.state.page.path, "/article/", "only the undecided route is sent");
    return answers();
  });
  const waits = [];
  const result = await run(
    ["https://example.com/", "https://example.com/cart/", "https://example.com/article/", "https://example.com/form/", "https://example.com/old/", "http://10.0.0.5/admin", "--twice"],
    {
      env: { TYPESAFE_API_KEY: KEY },
      fetchImpl: typesafe.fetchImpl,
      resolve: async () => PUBLIC,
      request: site.request,
      wait: async (ms) => waits.push(ms),
    },
  );
  assert.equal(result.code, 1);
  assert.equal(typesafe.calls.length, 1);
  assert.ok(site.calls.every((c) => c.headers["user-agent"] === USER_AGENT && c.headers.cookie === undefined));
  assert.ok(!site.calls.some((c) => c.url.includes("10.0.0.5") || c.url.includes("elsewhere")), "refused hosts are never requested");
  assert.equal(waits.length, site.calls.length - 1, "every request after the first waited for the pause");
  const out = result.stdout;
  assert.match(out, /^cache-boundary: 6 routes \(6 URLs on example\.com, 10\.0\.0\.5, fetched twice each\)\n/);
  assert.match(
    out,
    /\nProblems \(exit code 1\)\n {2}https:\/\/example\.com\/\n {6}a request without cookies got one visitor's page: page for a logged-in user \(body class logged-in\); purge the stored copy and make the cache skip requests with login or cart cookies\n {2}https:\/\/example\.com\/cart\/\n/,
  );
  assert.ok(!/Do not cache these paths:\n {4}\/ /.test(out), "a leaked copy is not turned into a rule against the home page");
  assert.match(out, /served from a cache \(cf-cache-status: HIT\) although it must not be cached/);
  assert.match(out, /https:\/\/example\.com\/form\/ {2}decided in code, nothing sent\n {6}changes between two requests without cookies: _wpnonce \(WordPress nonce\)\n/);
  assert.match(out, /\nCache: one stored copy for every visitor\n {2}https:\/\/example\.com\/article\/\n/);
  assert.match(out, /twice: no value changed between two requests without cookies/);
  assert.match(out, /\nNot checked\n {2}https:\/\/example\.com\/old\/\n {6}redirects to https:\/\/elsewhere\.example\.net\/new\/, a host you did not list, so it was not followed\n/);
  assert.match(out, / {2}http:\/\/10\.0\.0\.5\/admin\n {6}refused: 10\.0\.0\.5 is a private address\n/);
  assert.match(out, / {4}\/cart\/ and everything below it +WooCommerce cart page\n/);
  assert.ok(!out.includes(KEY));
});

test("when no route can be checked the exit code is 2", async () => {
  const result = await run(["http://127.0.0.1/", "https://[::1]/"], { env: { TYPESAFE_API_KEY: KEY }, resolve: async () => PUBLIC, request: () => assert.fail("no request") });
  assert.equal(result.code, 2);
  assert.match(result.stdout, /not checked 2/);
  assert.match(result.stdout, /refused: 127\.0\.0\.1 is a loopback address/);
});

test("usage errors and a missing key exit 2 with one plain line and no stack trace", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cache-boundary-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const empty = path.join(dir, "empty.txt");
  writeFileSync(empty, "# nothing yet\n");
  const cases = [
    [[SITE, "--threshold", "0.4"], '--threshold must be a number above 0.5 and at most 1, not "0.4".'],
    [[SITE, "--threshold", "high"], /--threshold must be a number above 0\.5/],
    [[SITE, "--timeout", "0"], '--timeout must be a number of seconds above 0 and at most 600, not "0".'],
    [[SITE, "--allow-cookie", "a*b"], '--allow-cookie takes a cookie name, optionally ending in *, not "a*b".'],
    [[SITE, "--frobnicate"], /Unknown option '--frobnicate'.*Run cache-boundary --help/],
    [[], /^Give at least one URL, saved \.html file or folder, or --urls <file>\./],
    [["--urls", empty], /empty\.txt holds no URLs\.$/],
    [["gopher://example.com/"], /only http and https URLs can be checked/],
    [["no-such-folder"], /Cannot read no-such-folder: there is no such file or folder\./],
    [[SITE], /^TYPESAFE_API_KEY is not set\./],
  ];
  for (const [args, expected] of cases) {
    const { code, stdout, stderr } = await run(args, { env: { TYPESAFE_API_KEY: "  " } });
    const label = args.join(" ") || "(no arguments)";
    assert.equal(code, 2, label);
    assert.equal(stdout, "", label);
    assert.equal(stderr.split("\n").length, 2, `one line for ${label}`);
    assert.ok(stderr.startsWith("cache-boundary: "), label);
    const message = stderr.slice("cache-boundary: ".length).trimEnd();
    if (typeof expected === "string") assert.equal(message, expected, label);
    else assert.match(message, expected, label);
  }
});

test("--help and --version, and --twice with only saved responses says it does nothing", async () => {
  assert.deepEqual(await run(["--help"]), { code: 0, stdout: USAGE, stderr: "" });
  assert.deepEqual(await run(["-v"]), { code: 0, stdout: "1.0.0\n", stderr: "" });
  const dry = await run([SITE, "--twice", "--dry-run"]);
  assert.equal(dry.code, 0);
  assert.equal(dry.stderr, "cache-boundary: --twice applies to URLs; saved responses are read once.\n");
});
