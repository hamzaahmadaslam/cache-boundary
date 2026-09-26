import "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { buildRules, decideRoute, jevVerdict, problemsOf, readAnswers } from "../src/decide.mjs";
import { analyze } from "../src/signals.mjs";

const answer = (visitor, token, choice, confidence) => ({
  visitor,
  token,
  rule: { choice, confidence, probabilities: { cache: 0, cache_with_vary_on_cookie: 0, do_not_cache: 0, [choice]: 1 } },
});
const route = (body, options = {}) => ({
  kind: "fetched",
  input: "https://example.com/p/",
  label: "https://example.com/p/",
  url: "https://example.com/p/",
  path: "/p/",
  status: 200,
  headers: { "content-type": "text/html", "cache-control": "public, max-age=300" },
  hasHeaders: true,
  setCookieNames: [],
  body,
  truncated: false,
  redirects: [],
  second: null,
  ...options,
});
const page = (body, bodyClass = "page") => `<html><head><link rel="stylesheet" href="/wp-content/themes/t/style.css"></head><body class="${bodyClass}">${body}</body></html>`;
const confident = answer(0.03, 0.04, "cache", 0.95);

test("Jev's answers count only at or above the threshold (yes) or at or below 1 minus it (no)", () => {
  const cases = [
    // visitor, token, rule, confidence, threshold -> verdict, reasons
    [0.2, 0.2, "cache", 0.8, 0.8, "cache", []],
    [0.21, 0.1, "cache", 0.95, 0.8, "review", ["unsure_visitor"]],
    [0.1, 0.1, "cache", 0.79, 0.8, "review", ["unsure_rule"]],
    [0.05, 0.05, "cache_with_vary_on_cookie", 0.9, 0.8, "vary", ["rule_vary"]],
    [0.05, 0.05, "cache", 0.85, 0.9, "review", ["unsure_rule"]],
    [0.8, 0.1, "do_not_cache", 0.5, 0.8, "do-not-cache", ["visitor_content"]],
    [0.1, 0.92, "do_not_cache", 0.9, 0.8, "do-not-cache", ["private_token"]],
    [0.3, 0.3, "do_not_cache", 0.85, 0.8, "do-not-cache", ["rule_do_not_cache"]],
    [0.9, 0.1, "cache", 0.9, 0.8, "review", ["answers_disagree"]],
    [0.5, 0.5, "cache", 0.3, 0.8, "review", ["unsure_visitor", "unsure_token", "unsure_rule"]],
  ];
  for (const [visitor, token, rule, confidence, threshold, verdict, reasons] of cases) {
    assert.deepEqual(jevVerdict(answer(visitor, token, rule, confidence), threshold), { verdict, reasons }, JSON.stringify([visitor, token, rule, confidence, threshold]));
  }
  const raw = {
    visitor_content: { type: "noul", noul: 0.1 },
    private_token: { type: "noul", noul: 0.2 },
    cache_rule: { type: "choice", choice: "cache", confidence: 0.9, probabilities: { cache: 0.93 } },
  };
  assert.deepEqual(readAnswers(raw), { visitor: 0.1, token: 0.2, rule: { choice: "cache", confidence: 0.9, probabilities: { cache: 0.93 } } });
  assert.equal(readAnswers({ ...raw, private_token: { type: "noul" } }), null);
  assert.equal(readAnswers({ ...raw, cache_rule: { ...raw.cache_rule, choice: "maybe" } }), null);
});

test("code decides first: a block signal wins over any answer, a vary signal turns cache into vary", () => {
  const session = analyze(route(page("<p>x</p>"), { setCookieNames: ["PHPSESSID"] }));
  assert.deepEqual(decideRoute(session, { asked: true, answer: confident }), { verdict: "do-not-cache", decidedBy: "code", reasons: [] });

  const shop = analyze(route(page('<div class="currency-switcher"></div>')));
  assert.deepEqual(decideRoute(shop, { asked: true, answer: confident }), { verdict: "vary", decidedBy: "code and jev", reasons: [] });
  assert.equal(decideRoute(shop, { asked: true, answer: answer(0.95, 0.1, "do_not_cache", 0.9) }).verdict, "do-not-cache");
  assert.equal(decideRoute(shop, { asked: true, answer: answer(0.5, 0.1, "cache", 0.9) }).verdict, "review");

  const plain = analyze(route(page("<p>An article.</p>")));
  assert.deepEqual(decideRoute(plain, { asked: true, answer: confident }), { verdict: "cache", decidedBy: "jev", reasons: [] });
  assert.deepEqual(decideRoute(plain, { asked: true, answer: null }), { verdict: "review", decidedBy: "jev", reasons: ["no_answer"] });
});

test("a page is called safe to store only with complete evidence: headers, and a body under the cap", () => {
  const noHeaders = analyze(route(page("<p>An article.</p>"), { kind: "saved", hasHeaders: false, headers: {}, status: null }));
  assert.deepEqual(decideRoute(noHeaders, { asked: true, answer: confident }), { verdict: "review", decidedBy: "jev", reasons: ["no_headers"] });
  const cut = analyze(route(page("<p>An article.</p>"), { truncated: true }));
  assert.deepEqual(decideRoute(cut, { asked: true, answer: confident }).reasons, ["truncated"]);
  const json = analyze(route('{"a":1}', { headers: { "content-type": "application/json" } }));
  assert.deepEqual(decideRoute(json, { asked: false, answer: null }), { verdict: "review", decidedBy: "code", reasons: ["not_html"] });
  const missing = analyze({ ...route(""), error: "the connection was refused" });
  assert.equal(decideRoute(missing, { asked: false, answer: null }).verdict, "not-checked");
  // Do-not-cache needs no extra evidence: storing less is never the unsafe side.
  assert.equal(decideRoute(noHeaders, { asked: true, answer: answer(0.95, 0.05, "do_not_cache", 0.9) }).verdict, "do-not-cache");
});

test("rules: paths not to cache, cookies that skip the cache, cookies to keep one copy per value", () => {
  const result = (analysis, verdict, decidedBy, reasons = []) => ({ analysis, verdict, decidedBy, reasons });
  const cart = analyze(route(page("<p>Cart</p>", "page woocommerce-cart woocommerce-page"), { path: "/cart/?step=1" }));
  const product = analyze(route(page('<p>Hoodie</p><form id="commentform"></form>', "single-product woocommerce"), { path: "/product/blue/", setCookieNames: ["wp_woocommerce_session_ab", "promo"] }));
  const members = analyze(route(page("<p>Welcome back</p>"), { path: "/club/" }));
  const shop = analyze(route(page('<div class="currency-switcher"></div>'), { path: "/shop/" }));
  const language = analyze(route(page("<p>Hallo</p>"), { path: "/de/", setCookieNames: ["pll_language"] }));
  const file = analyze(route(page("<p>Hi Robin</p>"), { kind: "saved", label: "dashboard.html", path: null }));
  const rules = buildRules([
    result(cart, "do-not-cache", "code"),
    result(product, "do-not-cache", "code"),
    result(members, "do-not-cache", "jev", ["visitor_content"]),
    result(shop, "vary", "code and jev"),
    result(language, "vary", "code and jev"),
    result(file, "do-not-cache", "jev", ["visitor_content"]),
    result(analyze(route(page("<p>review me</p>"), { path: "/maybe/" })), "review", "jev", ["unsure_rule"]),
  ]);
  assert.deepEqual(rules.paths, [
    { path: "/cart/", label: "https://example.com/p/", below: true, reason: "WooCommerce cart page" },
    { path: "/club/", label: "https://example.com/p/", below: false, reason: "Jev: shows content for one visitor" },
    { path: "/product/blue/", label: "https://example.com/p/", below: false, reason: "sets wp_woocommerce_session_*, promo on a visit" },
    { path: null, label: "dashboard.html", below: false, reason: "Jev: shows content for one visitor" },
  ]);
  assert.deepEqual(rules.bypass, [
    { cookie: "wordpress_logged_in_*", reason: "WordPress login" },
    { cookie: "wp_woocommerce_session_*", reason: "WooCommerce session" },
    { cookie: "woocommerce_items_in_cart", reason: "WooCommerce cart" },
    { cookie: "woocommerce_cart_hash", reason: "WooCommerce cart" },
    { cookie: "comment_author_*", reason: "comment forms fill in the commenter's name and email" },
    { cookie: "promo", reason: "a cookie the tool does not know" },
  ]);
  assert.deepEqual(rules.vary, [
    { cookie: "the cookie your currency switcher sets", reason: "currency switcher", paths: ["/shop/"] },
    { cookie: "pll_language", reason: "language choice", paths: ["/de/"] },
  ]);

  // A copy saved while logged in says nothing about the route itself: no path rule, but the login cookie is skipped.
  const loggedIn = analyze(route("<html><body class=\"page logged-in\"><p>Hi Robin</p></body></html>", { kind: "saved", path: "/home/" }));
  assert.match(loggedIn.signals.find((s) => s.id === "saved_personal").text, /save the page again without cookies/);
  const copyRules = buildRules([result(loggedIn, "do-not-cache", "code")]);
  assert.deepEqual(copyRules.paths, []);
  assert.deepEqual(copyRules.bypass, [{ cookie: "wordpress_logged_in_*", reason: "WordPress login" }]);
});

test("problems (exit code 1) are found only on fetched pages: a leak, or a cached page that must not be cached", () => {
  const leaked = analyze(route(page('<span class="cart-count">3</span>', "home logged-in")));
  assert.deepEqual(
    problemsOf(leaked, "do-not-cache").map((p) => p.id),
    ["leak"],
  );
  assert.match(problemsOf(leaked, "do-not-cache")[0].text, /^a request without cookies got one visitor's page: page for a logged-in user \(body class logged-in\); mini cart shows 3 items/);
  const cached = analyze(route(page("<p>Cart</p>", "woocommerce-cart"), { headers: { "content-type": "text/html", "cf-cache-status": "HIT" } }));
  assert.deepEqual(problemsOf(cached, "do-not-cache"), [{ id: "cached", text: "served from a cache (cf-cache-status: HIT) although it must not be cached" }]);
  assert.deepEqual(problemsOf(analyze(route(page("<p>x</p>"), { headers: { "content-type": "text/html", age: "30" } })), "cache"), []);
  assert.deepEqual(problemsOf(analyze(route(page("<p>x</p>", "logged-in"), { kind: "saved" })), "do-not-cache"), []);
});
