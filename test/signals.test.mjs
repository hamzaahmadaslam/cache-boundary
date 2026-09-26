import "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { analyze, cacheHit, classifyCookie } from "../src/signals.mjs";

const route = (body, options = {}) => ({
  kind: "fetched",
  input: "https://example.com/p/",
  label: "https://example.com/p/",
  url: "https://example.com/p/",
  path: "/p/",
  status: 200,
  headers: { "content-type": "text/html; charset=UTF-8" },
  hasHeaders: true,
  setCookieNames: [],
  body,
  truncated: false,
  redirects: [],
  second: null,
  ...options,
});
const page = (body, bodyClass = "page") => `<!doctype html><html><head><title>T</title></head><body class="${bodyClass}">${body}</body></html>`;
const signal = (analysis, id) => analysis.signals.find((s) => s.id === id);
const ids = (analysis, level) => analysis.signals.filter((s) => s.level === level).map((s) => s.id);

test("Set-Cookie names are sorted into blocking, vary and harmless cookies; --allow-cookie makes one harmless", () => {
  const kinds = (name, allowed) => {
    const c = classifyCookie(name, allowed);
    return [c.kind, c.level, c.rule];
  };
  assert.deepEqual(kinds("wordpress_logged_in_0123abcd"), ["login", "block", "wordpress_logged_in_*"]);
  assert.deepEqual(kinds("wp_woocommerce_session_9f8e"), ["session", "block", "wp_woocommerce_session_*"]);
  assert.deepEqual(kinds("woocommerce_items_in_cart"), ["cart", "block", "woocommerce_items_in_cart"]);
  assert.deepEqual(kinds("comment_author_email_0123"), ["personal", "block", "comment_author_*"]);
  assert.deepEqual(kinds("PHPSESSID"), ["session", "block", "PHPSESSID"]);
  assert.deepEqual(kinds("laravel_session"), ["session", "block", "laravel_session"]);
  assert.deepEqual(kinds("XSRF-TOKEN"), ["session", "block", "XSRF-TOKEN"]);
  assert.deepEqual(kinds("pll_language"), ["choice", "vary", "pll_language"]);
  assert.deepEqual(kinds("wp-postpass_0123"), ["choice", "vary", "wp-postpass_*"]);
  assert.deepEqual(kinds("__cf_bm"), ["infrastructure", "info", "__cf_bm"]);
  assert.deepEqual(kinds("promo_banner"), ["unknown", "block", "promo_banner"]);
  assert.deepEqual(kinds("promo_banner", ["promo_*"]), ["allowed", "info", "promo_banner"]);

  const a = analyze(route(page("<p>Hi</p>"), { setCookieNames: ["wp_woocommerce_session_9f8e", "promo_banner", "__cf_bm"] }));
  assert.match(signal(a, "set_cookie").text, /^sets wp_woocommerce_session_\* \(WooCommerce session\), promo_banner \(a cookie the tool does not know; if it is harmless, run again with --allow-cookie promo_banner\) on a visit without cookies$/);
  assert.equal(signal(a, "set_cookie").level, "block");
  assert.equal(signal(a, "set_cookie_other").text, "sets __cf_bm (set by Cloudflare)");
});

test("Cache-Control private, no-store or no-cache and Vary: * block; Vary: Cookie asks for a copy per cookie", () => {
  const headers = (extra) => ({ "content-type": "text/html", ...extra });
  const wordpress = analyze(
    route(page("<p>x</p>"), {
      headers: headers({ "cache-control": "no-cache, must-revalidate, max-age=0, no-store, private", expires: "Wed, 11 Jan 1984 05:00:00 GMT" }),
    }),
  );
  assert.equal(signal(wordpress, "cache_control").text, "Cache-Control forbids a shared copy: no-cache, must-revalidate, max-age=0, no-store, private (the no-cache headers WordPress sends)");
  assert.match(signal(analyze(route(page("x"), { headers: headers({ "cache-control": "no-cache" }) })), "cache_control").text, /ask the site before every reuse/);
  assert.deepEqual(ids(analyze(route(page("x"), { headers: headers({ "cache-control": "public, max-age=600" }) })), "block"), []);
  assert.deepEqual(ids(analyze(route(page("x"), { headers: headers({ "cdn-cache-control": "no-store" }) })), "block"), ["cdn-cache-control"]);
  assert.deepEqual(ids(analyze(route(page("x"), { headers: headers({ vary: "*" }) })), "block"), ["vary_all"]);
  const vary = analyze(route(page("x"), { headers: headers({ vary: "Accept-Encoding, Cookie, User-Agent, X-Device" }) }));
  assert.deepEqual(ids(vary, "vary"), ["vary_cookie"]);
  assert.deepEqual(ids(vary, "caution"), ["vary_agent", "vary_other"]);
  assert.equal(cacheHit({ "x-cache": "HIT, MISS" }), "x-cache: HIT, MISS");
  assert.equal(cacheHit({ "cf-cache-status": "DYNAMIC" }), null);
  assert.equal(cacheHit({ "cache-status": "ExampleCache; hit" }), "cache-status: ExampleCache; hit");
  assert.equal(cacheHit({ age: "120" }), "age: 120");
});

test("login markers block, and count as a leak only when a request without cookies got them", () => {
  const html = page(
    '<div id="wpadminbar" class="nojq"></div><p class="logged-in-as">Logged in as Robin.</p><style>#wpadminbar{display:block}</style>',
    "home logged-in admin-bar",
  );
  const fetched = analyze(route(html));
  assert.deepEqual(ids(fetched, "block"), ["logged_in", "admin_bar", "logged_in_as"]);
  assert.ok(fetched.signals.filter((s) => s.level === "block").every((s) => s.leak));
  const saved = analyze(route(html, { kind: "saved" }));
  assert.ok(saved.signals.every((s) => !s.leak), "a saved copy may come from a logged-in browser");
  // CSS that mentions the admin bar is not an admin bar.
  assert.deepEqual(ids(analyze(route(page("<style>#wpadminbar{top:0}</style><p>Hi</p>"))), "block"), []);
});

test("WooCommerce cart, checkout and account pages are found from body classes or content, and full mini carts block", () => {
  const kind = (html) => signal(analyze(route(html)), "woo_page");
  assert.equal(kind(page("<p>x</p>", "page woocommerce-cart woocommerce-page")).pageKind, "cart");
  assert.equal(kind(page("<p>x</p>", "page woocommerce-checkout woocommerce-order-received")).pageKind, "checkout");
  assert.equal(kind(page('<div class="wp-block-woocommerce-checkout"></div>')).text, "WooCommerce checkout page (block wp-block-woocommerce-checkout)");
  assert.equal(kind(page('<nav class="woocommerce-MyAccount-navigation"></nav>')).pageKind, "account");
  assert.equal(kind(page('<form class="login"><input type="hidden" name="woocommerce-login-nonce" value="3fa81c07d2"></form>')).pageKind, "account");
  assert.equal(kind(page("<p>A blue hoodie</p>", "single-product woocommerce")), undefined);

  const full = analyze(route(page('<a class="cart-contents" href="/cart/"><span class="amount">$60.00</span> <span class="count">2 items</span></a>')));
  assert.equal(signal(full, "cart_count").text, "mini cart shows 2 items (a.cart-contents .count)");
  assert.equal(signal(full, "cart_count").leak, true);
  const badge = analyze(route(page('<span class="wc-block-mini-cart__badge">1</span>')));
  assert.equal(signal(badge, "cart_count").text, "mini cart shows 1 item (class wc-block-mini-cart__badge)");
  const empty = analyze(route(page('<a class="cart-contents" href="/cart/"><span class="count">0 items</span></a><ul class="product-categories"><li><span class="count">(12)</span></li></ul>')));
  assert.deepEqual(ids(empty, "block"), [], "category counts are not cart counts");
  assert.equal(signal(empty, "cart_count_zero").level, "info");
  const listed = analyze(route(page('<li class="woocommerce-mini-cart-item mini_cart_item">Blue hoodie</li>')));
  assert.deepEqual(ids(listed, "block"), ["mini_cart_items"]);
});

test("tokens are found in forms, scripts, attributes, meta tags and links, and reported by name and shape only", () => {
  const html = page(
    [
      '<form id="commentform" method="post"><input type="hidden" name="_wpnonce" value="a1b2c3d4e5"><input type="hidden" name="comment_post_ID" value="12"></form>',
      '<button data-nonce="9f8e7d6c5b">Save</button>',
      '<meta name="csrf-token" content="Zx81kQ2mN7pL0vB4">',
      '<a href="/cart/?remove_item=abc&amp;_wpnonce=0a9b8c7d6e">Remove</a>',
      '<script>var wpApiSettings = {"root":"https:\\/\\/example.com\\/wp-json\\/","nonce":"4d3c2b1a09","versionString":"wp\\/v2\\/"};</script>',
      '<script>var wcBlocksMiddlewareConfig = {storeApiNonce: "77aa88bb99", wcStoreApiNonceTimestamp: "1790000000"};</script>',
      "<script>wp.apiFetch.use( wp.apiFetch.createNonceMiddleware( \"12ab34cd56\" ) );</script>",
      '<script>var config = {"nonces":{"floatingButtonsClickTracking":"5e6f7a8b9c"},"nonce_life":"86400","tokenType":"Bearer"};</script>',
      '<script nonce="r4nd0mCspValue1">console.log(1)</script>',
    ].join(""),
  );
  const a = analyze(route(html));
  assert.deepEqual(
    a.tokens.map((t) => [t.name, t.where, t.label]),
    [
      ["_wpnonce", "form #commentform", "WordPress nonce"],
      ["wpApiSettings.nonce", "inline script", "WordPress REST API nonce"],
      ["wcBlocksMiddlewareConfig.storeApiNonce", "inline script", "WooCommerce Store API nonce"],
      ["wp.apiFetch.createNonceMiddleware", "inline script", "WordPress REST API nonce"],
      ["nonces.floatingButtonsClickTracking", "inline script", "nonce"],
      ["data-nonce", "data-nonce attribute on <button>", "nonce"],
      ["csrf-token", "meta tag", "CSRF token"],
      ["_wpnonce", "link (href of <a>)", "WordPress nonce"],
      ["nonce", "<script> nonce attribute", "Content-Security-Policy nonce"],
    ],
  );
  const caution = signal(a, "tokens");
  assert.equal(caution.level, "caution");
  assert.match(caution.text, /not compared \(run with --twice to compare two requests\); WordPress nonces stay valid for 12 to 24 hours, so a stored copy must expire within 12 hours$/);
  for (const value of ["a1b2c3d4e5", "9f8e7d6c5b", "Zx81kQ2mN7pL0vB4", "4d3c2b1a09", "77aa88bb99", "12ab34cd56"]) {
    assert.ok(!JSON.stringify(a.signals).includes(value), `${value} is not in the signals`);
    assert.ok(!JSON.stringify(a.checks).includes(value), `${value} is not in the checks`);
  }
});

test("with a second copy, a changed nonce blocks and a stable one only asks for a short cache lifespan", () => {
  const nonce = (value, extra = "") => page(`<form id="f"><input type="hidden" name="_wpnonce" value="${value}"></form>${extra}`);
  const stable = analyze(route(nonce("a1b2c3d4e5"), { second: { body: nonce("a1b2c3d4e5"), headers: {} } }));
  assert.equal(stable.compared, true);
  assert.deepEqual(ids(stable, "block"), []);
  assert.match(signal(stable, "tokens").text, /the same in both requests; WordPress nonces stay valid/);
  assert.equal(stable.checks.twice, "no value changed between two requests without cookies");

  const changing = analyze(route(nonce("a1b2c3d4e5"), { second: { body: nonce("f6e5d4c3b2"), headers: {} } }));
  assert.equal(signal(changing, "token_changed").text, "changes between two requests without cookies: _wpnonce (WordPress nonce)");

  const other = analyze(
    route(page('<div data-uid="k7Q2x9Lm4Pz8" id="box"></div><input type="hidden" name="csrf_token" value="Q1w2E3r4T5y6">'), {
      second: { body: page('<div data-uid="Wm3p8Rt5Yq1n" id="box"></div><input type="hidden" name="csrf_token" value="Z9x8C7v6B5n4">'), headers: {} },
    }),
  );
  assert.equal(signal(other, "values_changed").level, "caution");
  assert.match(signal(other, "values_changed").text, /changed between two requests \(data-uid/);
  assert.equal(signal(other, "value_changed_token").text, "changes between two requests without cookies: csrf_token");

  const script = analyze(
    route(page('<script>var cfg = {"sessionKey":"s3ss10nV4lue","sessionTimeout":"3600"};</script>'), {
      second: { body: page('<script>var cfg = {"sessionKey":"n3wS3ss10nX","sessionTimeout":"3600"};</script>'), headers: {} },
    }),
  );
  assert.deepEqual(script.tokens.map((tk) => [tk.name, tk.label, tk.comparison]), [["cfg.sessionKey", "session ID", "changed"]]);
  assert.equal(signal(script, "token_changed").text, "changes between two requests without cookies: cfg.sessionKey (session ID)");

  const failed = analyze(route(nonce("a1b2c3d4e5"), { second: { error: "the second request got HTTP 503, the first HTTP 200" } }));
  assert.equal(failed.compared, false);
  assert.equal(signal(failed, "second_failed").level, "info");
});

test("switchers and password forms ask for a copy per cookie; geolocation, fragments and cache hits are noted", () => {
  const shop = analyze(
    route(page('<div class="currency-switcher"><select name="currency"><option>USD</option></select></div><link rel="stylesheet" href="/wp-content/plugins/woo-multi-currency/css/a.css">')),
  );
  assert.equal(signal(shop, "currency_switcher").text, "currency switcher (class currency-switcher, plugin folder woo-multi-currency)");
  assert.equal(signal(shop, "currency_switcher").level, "vary");
  const post = analyze(route(page('<form action="/wp-login.php?action=postpass" class="post-password-form" method="post"></form>')));
  assert.equal(signal(post, "password_form").level, "vary");
  assert.equal(post.facts.passwordForm, true);
  const woo = analyze(
    route(page("<script>var wc_geolocation_params = {};var wc_cart_fragments_params = {};</script>", "woocommerce-no-js"), {
      headers: { "content-type": "text/html", "x-cache": "HIT" },
    }),
  );
  assert.deepEqual(ids(woo, "caution"), ["geolocation", "cart_fragments"]);
  assert.equal(woo.servedFromCache, "x-cache: HIT");
  assert.equal(woo.facts.woocommerce, true);
  const notChecked = analyze(route("", { status: 404 }));
  assert.deepEqual([notChecked.status, notChecked.reason], ["not_checked", "HTTP 404"]);
  const json = analyze(route('{"items":[]}', { headers: { "content-type": "application/json" } }));
  assert.equal(json.html, false);
});
