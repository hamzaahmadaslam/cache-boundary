// The checks made in code before any question goes to Jev: response headers (Set-Cookie, Cache-Control, Vary and
// their CDN variants), WordPress and WooCommerce markers, tokens in forms, scripts, attributes and links, and, with
// --twice, the values that change between two requests without cookies. Every signal has a level:
//   block    the response must not be served to other visitors as it is; the route is decided in code
//   vary     the page changes with a cookie, so at most one stored copy per cookie value
//   caution  shareable only under a condition, such as a cache lifespan under 12 hours
//   info     context for the report
// Token and cookie values are used here (to compare two copies) and never printed or sent anywhere.
import { attributes, blankElements, elements, forms as readForms, removeComments, tags, titleOf, visibleText } from "./html.mjs";
import { compareCopies, findTokens, isTokenName } from "./tokens.mjs";

// ---------------------------------------------------------------------------------------------------------------
// Cookies

// [name pattern, kind, what it is, how the rules list it (null: the name itself)]
const COOKIES = [
  [/^wordpress_logged_in_/, "login", "WordPress login", "wordpress_logged_in_*"],
  [/^wordpress_sec_/, "login", "WordPress login", "wordpress_sec_*"],
  [/^wordpress_[0-9a-f]{32}$/, "login", "WordPress login", "wordpress_*"],
  [/^wordpress_test_cookie$/, "harmless", "WordPress test cookie", null],
  [/^wp-settings-(time-)?\d+$/, "login", "WordPress user settings", "wp-settings-*"],
  [/^wp_woocommerce_session_/, "session", "WooCommerce session", "wp_woocommerce_session_*"],
  [/^woocommerce_(items_in_cart|cart_hash)$/, "cart", "WooCommerce cart", null],
  [/^woocommerce_recently_viewed$/, "personal", "WooCommerce recently viewed products", null],
  [/^comment_author_/, "personal", "comment author's name, email or website", "comment_author_*"],
  [/^wp-postpass_/, "choice", "password for a protected post", "wp-postpass_*"],
  [/^(pll_language|wp-wpml_current_language|_icl_current_language)$/, "choice", "language choice", null],
  [/^(wmc_current_currency|woocs_current_currency|wcml_client_currency|aelia_cs_selected_currency)$/, "choice", "currency choice", null],
  [/^(__cf_bm|__cflb|__cfruid|_cfuvid|cf_clearance)$/, "infrastructure", "set by Cloudflare", null],
  [/^(AWSALB|AWSALBCORS|AWSALBTG|AWSALBTGCORS)$/, "infrastructure", "set by an AWS load balancer", null],
  [/^BIGipServer/, "infrastructure", "set by an F5 load balancer", "BIGipServer*"],
  [/^(incap_ses_|visid_incap_|nlbi_)/, "infrastructure", "set by Imperva", null],
  [/^S?SESS[0-9a-f]{32}$/, "session", "Drupal session", "SESS*"],
  [/^(XSRF-TOKEN|csrftoken|_csrf|csrf_token|_xsrf)$/i, "session", "CSRF token", null],
  [/^(PHPSESSID|JSESSIONID|ASP\.NET_SessionId|laravel_session|ci_session|connect\.sid|_session_id|sid)$/i, "session", "session ID", null],
  [/sess(ion)?(_?id)?$|^sess/i, "session", "session", null],
];

const COOKIE_LEVELS = {
  login: "block",
  session: "block",
  cart: "block",
  personal: "block",
  unknown: "block",
  choice: "vary",
  infrastructure: "info",
  harmless: "info",
  allowed: "info",
};

/** Whether a cookie name matches one of the --allow-cookie patterns (a trailing * matches a prefix). */
function allowedCookie(name, allowed) {
  return allowed.some((pattern) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern));
}

/** { name, kind, what, rule, level } for a cookie name. */
export function classifyCookie(name, allowed = []) {
  if (allowedCookie(name, allowed)) return { name, kind: "allowed", what: "allowed with --allow-cookie", rule: name, level: "info" };
  for (const [pattern, kind, what, rule] of COOKIES) {
    if (pattern.test(name)) return { name, kind, what, rule: rule ?? name, level: COOKIE_LEVELS[kind] };
  }
  return { name, kind: "unknown", what: "a cookie the tool does not know", rule: name, level: "block" };
}

function describeCookies(cookies) {
  const seen = new Map();
  for (const cookie of cookies) if (!seen.has(cookie.rule)) seen.set(cookie.rule, cookie);
  return [...seen.values()]
    .map((cookie) =>
      cookie.kind === "unknown"
        ? `${cookie.rule} (a cookie the tool does not know; if it is harmless, run again with --allow-cookie ${cookie.rule})`
        : `${cookie.rule} (${cookie.what})`,
    )
    .join(", ");
}

// ---------------------------------------------------------------------------------------------------------------
// Headers

function directives(value) {
  const out = new Map();
  for (const part of String(value ?? "").split(",")) {
    const [name, ...rest] = part.split("=");
    const key = name.trim().toLowerCase();
    if (key) out.set(key, rest.join("=").trim().replace(/^"|"$/g, ""));
  }
  return out;
}

const HIT_HEADERS = [
  "x-cache",
  "cf-cache-status",
  "x-litespeed-cache",
  "x-proxy-cache",
  "x-kinsta-cache",
  "x-cache-status",
  "x-fastcgi-cache",
  "x-nginx-cache",
  "x-srcache-fetch-status",
  "x-varnish-cache",
];

/** The header that shows the response came from a cache ("x-cache: HIT", "age: 120"), or null. */
export function cacheHit(headers) {
  for (const name of HIT_HEADERS) {
    const value = headers[name];
    if (value && /\bhit\b/i.test(value)) return `${name}: ${value}`;
  }
  if (headers["cache-status"] && /;\s*hit\b/i.test(headers["cache-status"])) return `cache-status: ${headers["cache-status"]}`;
  const age = Number.parseInt(headers.age, 10);
  if (age > 0) return `age: ${headers.age}`;
  return null;
}

/** Signals from the response headers: cookies, Cache-Control and its CDN variants, Vary, Store API tokens. */
export function headerSignals(page, { allowCookies = [] } = {}) {
  const signals = [];
  if (!page.hasHeaders) return signals;
  const h = page.headers;
  const visit = page.kind === "fetched" ? " on a visit without cookies" : "";

  const cookies = [...new Set(page.setCookieNames)].map((name) => classifyCookie(name, allowCookies));
  const blocking = cookies.filter((c) => c.level === "block");
  const choices = cookies.filter((c) => c.level === "vary");
  const other = cookies.filter((c) => c.level === "info");
  if (blocking.length) {
    signals.push({ id: "set_cookie", level: "block", text: `sets ${describeCookies(blocking)}${visit}`, cookies: blocking });
  }
  if (choices.length) signals.push({ id: "set_cookie_choice", level: "vary", text: `sets ${describeCookies(choices)}`, cookies: choices });
  if (other.length) signals.push({ id: "set_cookie_other", level: "info", text: `sets ${describeCookies(other)}`, cookies: other });

  const wordpressNoCache = /\b1984\b/.test(h.expires ?? "") ? " (the no-cache headers WordPress sends)" : "";
  const cc = directives(h["cache-control"]);
  if (cc.has("private") || cc.has("no-store")) {
    signals.push({ id: "cache_control", level: "block", text: `Cache-Control forbids a shared copy: ${h["cache-control"]}${wordpressNoCache}` });
  } else if (cc.has("no-cache")) {
    signals.push({
      id: "cache_control",
      level: "block",
      text: `Cache-Control: ${h["cache-control"]} (a cache must ask the site before every reuse)${wordpressNoCache}`,
    });
  } else if (!h["cache-control"] && /no-cache/i.test(h.pragma ?? "")) {
    signals.push({ id: "cache_control", level: "block", text: `Pragma: ${h.pragma} (no Cache-Control header)` });
  }
  for (const name of ["surrogate-control", "cdn-cache-control", "cloudflare-cdn-cache-control"]) {
    const d = directives(h[name]);
    if (d.has("no-store") || d.has("private")) signals.push({ id: name, level: "block", text: `${name}: ${h[name]}` });
  }
  const litespeed = directives(h["x-litespeed-cache-control"]);
  if (litespeed.has("no-cache") || litespeed.has("private")) {
    signals.push({ id: "litespeed", level: "block", text: `X-LiteSpeed-Cache-Control: ${h["x-litespeed-cache-control"]}` });
  }

  const vary = String(h.vary ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (vary.includes("*")) signals.push({ id: "vary_all", level: "block", text: "Vary: * (no stored copy may be reused)" });
  if (vary.includes("cookie")) {
    signals.push({ id: "vary_cookie", level: "vary", text: "Vary: Cookie (the site says the page changes with cookies)" });
  }
  if (vary.includes("user-agent")) {
    signals.push({ id: "vary_agent", level: "caution", text: "Vary: User-Agent: keep one stored copy per device type" });
  }
  if (vary.includes("accept-language")) {
    signals.push({ id: "vary_language", level: "caution", text: "Vary: Accept-Language: keep one stored copy per language" });
  }
  const unusual = vary.filter((v) => !["*", "cookie", "user-agent", "accept-language", "accept-encoding", "accept", "origin"].includes(v));
  if (unusual.length) {
    signals.push({ id: "vary_other", level: "caution", text: `Vary: ${unusual.join(", ")}: the cache key must include ${unusual.length === 1 ? "it" : "them"}` });
  }

  if (h["cart-token"]) signals.push({ id: "cart_token", level: "block", text: "Cart-Token header (a WooCommerce Store API cart token)" });
  if (h.nonce) signals.push({ id: "nonce_header", level: "block", text: "Nonce header (a WooCommerce Store API nonce)" });
  return signals;
}

// ---------------------------------------------------------------------------------------------------------------
// Page

/** What the checks need from one HTML document. */
export function readPage(html) {
  const noComments = removeComments(html);
  const blanked = blankElements(noComments, ["script", "style", "template"]);
  let body = null;
  const classes = new Set();
  const ids = new Set();
  const data = [];
  const links = [];
  const metas = [];
  const nonceAttributes = [];
  for (const tag of tags(blanked)) {
    if (tag.closing) continue;
    const a = attributes(tag.text);
    if (tag.name === "body" && !body) body = a;
    if (a.class) for (const name of a.class.split(/\s+/)) if (name) classes.add(name);
    if (a.id) ids.add(a.id);
    for (const [name, value] of Object.entries(a)) {
      if (!value) continue;
      if (name.startsWith("data-") && isTokenName(name)) data.push({ tag: tag.name, name, value });
      if ((name === "href" || name === "action" || name === "src" || name === "formaction") && /[?&;]/.test(value)) {
        links.push({ tag: tag.name, attribute: name, value });
      }
    }
    if (tag.name === "meta") metas.push(a);
    if (a.nonce && (tag.name === "script" || tag.name === "style" || tag.name === "link")) nonceAttributes.push({ tag: tag.name, value: a.nonce });
  }
  const scripts = [];
  for (const el of elements(noComments, "script")) {
    const a = attributes(el.open);
    const type = (a.type ?? "").toLowerCase();
    if (a.src || (type && !/javascript|ecmascript|module|json/.test(type))) continue;
    scripts.push(noComments.slice(el.contentStart, el.contentEnd));
  }
  return {
    raw: html,
    noComments,
    blanked,
    title: titleOf(noComments),
    bodyClasses: (body?.class ?? "").split(/\s+/).filter(Boolean),
    classes,
    ids,
    data,
    links,
    metas,
    nonceAttributes,
    scripts,
    forms: readForms(blanked),
    text: visibleText(html),
  };
}

const WOO_BODY_CLASSES = [
  ["woocommerce-cart", "cart"],
  ["woocommerce-checkout", "checkout"],
  ["woocommerce-account", "account"],
  ["woocommerce-order-received", "checkout"],
  ["woocommerce-order-pay", "checkout"],
];
/** Signals about one copy of a page (who was logged in, what was in the cart), not about the route itself. */
export const COPY_SIGNALS = new Set(["logged_in", "admin_bar", "logged_in_as", "mini_cart_items", "cart_count"]);
export const PAGE_KINDS = { cart: "WooCommerce cart page", checkout: "WooCommerce checkout page", account: "WooCommerce account page" };

/** The WooCommerce page this is (cart, checkout or account) and the marker that shows it, or null. */
function wooPage(page) {
  for (const [name, kind] of WOO_BODY_CLASSES) if (page.bodyClasses.includes(name)) return { kind, marker: `body class ${name}` };
  const has = (name) => page.classes.has(name);
  if (has("wp-block-woocommerce-cart")) return { kind: "cart", marker: "block wp-block-woocommerce-cart" };
  if (has("woocommerce-cart-form")) return { kind: "cart", marker: "form.woocommerce-cart-form" };
  if (has("wc-empty-cart-message") || has("cart-empty")) return { kind: "cart", marker: "empty cart message" };
  if (has("wp-block-woocommerce-checkout")) return { kind: "checkout", marker: "block wp-block-woocommerce-checkout" };
  if (page.forms.some((f) => /\bwoocommerce-checkout\b/.test(f.className))) return { kind: "checkout", marker: "checkout form" };
  const account = ["woocommerce-MyAccount-navigation", "woocommerce-MyAccount-content"].find(has);
  if (account) return { kind: "account", marker: `class ${account}` };
  if (page.forms.some((f) => f.fields.some((field) => field.name === "woocommerce-login-nonce"))) {
    return { kind: "account", marker: "WooCommerce login form" };
  }
  return null;
}

const COUNT_CLASSES = new Set([
  "cart-count",
  "cart-counter",
  "cart-contents-count",
  "cart-items-count",
  "cart-item-count",
  "cart-quantity",
  "cart-qty",
  "mini-cart-count",
  "header-cart-count",
  "wc-block-mini-cart__badge",
]);
const SMALL_ELEMENT = /<(span|div|sup|sub|em|strong|b|i|small|bdi|mark|a)\b([^<>]*)>\s*([^<]{0,40}?)\s*<\/\1\s*>/gi;
const STOREFRONT_CART = /<a\b[^<>]*\bclass=["'][^"']*\bcart-contents\b[^"']*["'][^<>]*>([\s\S]{0,1500}?)<\/a\s*>/gi;
const COUNT_IN = /<span\b[^<>]*\bclass=["'][^"']*\bcount\b[^"']*["'][^<>]*>\s*\(?\s*(\d{1,4})\b/i;
const ASTRA_CART = /\bclass=["'][^"']*\bast-cart-menu-wrap\b[^"']*["'][^<>]*>\s*<span\b[^<>]*\bclass=["'][^"']*\bcount\b[^"']*["'][^<>]*>\s*(\d{1,4})\b/gi;

/** Item counts shown by mini carts: [{ count, where }]. */
function cartCounts(blanked) {
  const found = [];
  for (const m of blanked.matchAll(SMALL_ELEMENT)) {
    const className = /\bclass\s*=\s*["']([^"']*)["']/i.exec(m[2])?.[1];
    const match = className?.split(/\s+/).find((name) => COUNT_CLASSES.has(name));
    const number = match ? /^\(?\s*(\d{1,4})\b/.exec(m[3]) : null;
    if (number) found.push({ count: Number(number[1]), where: `class ${match}` });
  }
  for (const m of blanked.matchAll(STOREFRONT_CART)) {
    const number = COUNT_IN.exec(m[1]);
    if (number) found.push({ count: Number(number[1]), where: "a.cart-contents .count" });
  }
  for (const m of blanked.matchAll(ASTRA_CART)) found.push({ count: Number(m[1]), where: ".ast-cart-menu-wrap .count" });
  return found;
}

const CURRENCY_PLUGINS = [
  "woocommerce-currency-switcher",
  "woo-multi-currency",
  "woocommerce-multi-currency",
  "woocommerce-aelia-currencyswitcher",
  "currency-switcher-woocommerce",
];
const CURRENCY_CLASS = /currency[-_]?(switcher|selector|converter)|wcml[-_]?currency|^woocs[-_]|^wmc[-_]/i;
const REGION_CLASS = /(country|region|location)[-_]?(switcher|selector|picker)/i;

function firstMatch(page, pattern) {
  for (const name of page.classes) if (pattern.test(name)) return `class ${name}`;
  for (const name of page.ids) if (pattern.test(name)) return `id ${name}`;
  return null;
}

/** Facts about the site that the suggested rules use. */
function siteFacts(page) {
  const raw = page.raw;
  const wordpress = /\/wp-content\/|\/wp-includes\/|api\.w\.org|<meta[^>]+generator[^>]+WordPress/i.test(raw);
  const woocommerce =
    page.bodyClasses.some((c) => /^woocommerce(-js|-no-js|-page)?$/.test(c)) ||
    /\/plugins\/woocommerce\/|wc_add_to_cart_params|woocommerce_params|wcBlocksMiddlewareConfig|wc_cart_fragments_params/.test(raw) ||
    [...page.classes].some((c) => c.startsWith("wp-block-woocommerce-"));
  return {
    wordpress,
    woocommerce,
    commentForm: page.ids.has("commentform") || page.classes.has("comment-form"),
    passwordForm: page.classes.has("post-password-form"),
    recentlyViewed: page.classes.has("widget_recently_viewed_products"),
  };
}

/** Signals from the HTML: login and cart markers, WooCommerce pages, switchers, cart fragments, forms. */
export function pageSignals(page, { fetched }) {
  const signals = [];
  const leak = fetched ? { leak: true } : {};
  if (page.bodyClasses.includes("logged-in")) {
    signals.push({ id: "logged_in", level: "block", text: "page for a logged-in user (body class logged-in)", ...leak });
  }
  if (page.bodyClasses.includes("admin-bar") || page.ids.has("wpadminbar")) {
    signals.push({ id: "admin_bar", level: "block", text: "WordPress admin bar (id wpadminbar or body class admin-bar)", ...leak });
  }
  if (page.classes.has("logged-in-as")) {
    signals.push({ id: "logged_in_as", level: "block", text: "comment form names the logged-in user (class logged-in-as)", ...leak });
  }
  const woo = wooPage(page);
  if (woo) signals.push({ id: "woo_page", level: "block", text: `${PAGE_KINDS[woo.kind]} (${woo.marker})`, pageKind: woo.kind });
  const miniCartItem = ["woocommerce-mini-cart-item", "mini_cart_item"].find((name) => page.classes.has(name));
  if (miniCartItem) {
    signals.push({ id: "mini_cart_items", level: "block", text: `mini cart lists products (class ${miniCartItem})`, ...leak });
  }
  const counts = cartCounts(page.blanked);
  const full = counts.find((c) => c.count > 0);
  if (full) {
    signals.push({ id: "cart_count", level: "block", text: `mini cart shows ${full.count} item${full.count === 1 ? "" : "s"} (${full.where})`, ...leak });
  } else if (counts.length) {
    signals.push({ id: "cart_count_zero", level: "info", text: `mini cart shows 0 items (${counts[0].where})` });
  }
  if (!fetched && signals.some((s) => COPY_SIGNALS.has(s.id))) {
    signals.push({
      id: "saved_personal",
      level: "info",
      text: "this copy comes from a browser that was logged in or had a cart: save the page again without cookies to see what anonymous visitors get",
    });
  }
  if (page.classes.has("post-password-form")) {
    signals.push({
      id: "password_form",
      level: "vary",
      text: "password-protected post (form.post-password-form): visitors who enter the password see more (cookie wp-postpass_*)",
    });
  }
  const plugin = CURRENCY_PLUGINS.find((slug) => page.raw.includes(`/plugins/${slug}/`));
  const currencyMarker = firstMatch(page, CURRENCY_CLASS);
  if (plugin || currencyMarker) {
    const where = [currencyMarker, plugin && `plugin folder ${plugin}`].filter(Boolean).join(", ");
    signals.push({ id: "currency_switcher", level: "vary", text: `currency switcher (${where})` });
  }
  const regionMarker = firstMatch(page, REGION_CLASS);
  if (regionMarker) signals.push({ id: "region_switcher", level: "vary", text: `country or region switcher (${regionMarker})` });
  if (page.raw.includes("wc_geolocation_params")) {
    signals.push({
      id: "geolocation",
      level: "caution",
      text: "WooCommerce geolocation for cached pages (wc_geolocation_params) adds a ?v= location hash to links: keep query strings in the cache key",
    });
  }
  if (page.raw.includes("wc_cart_fragments_params")) {
    signals.push({
      id: "cart_fragments",
      level: "caution",
      text: "WooCommerce cart fragments (wc_cart_fragments_params) refresh the mini cart after the page loads: store only a copy with an empty cart",
    });
  }
  if (page.classes.has("widget_recently_viewed_products")) {
    signals.push({ id: "recently_viewed", level: "caution", text: "recently viewed products widget reads the woocommerce_recently_viewed cookie" });
  }
  const facts = siteFacts(page);
  if (facts.commentForm) {
    signals.push({ id: "comment_form", level: "info", text: "comment form: returning commenters get their name and email filled in (comment_author_* cookies)" });
  }
  return { signals, facts, pageKind: woo?.kind ?? null };
}

// ---------------------------------------------------------------------------------------------------------------
// Token signals

const WORDPRESS_NONCE = /WordPress|WooCommerce/;

function tokenList(tokens, limit = 6) {
  const names = tokens.slice(0, limit).map((t) => `${t.name} (${t.label})`);
  if (tokens.length > limit) names.push(`${tokens.length - limit} more`);
  return names.join(", ");
}

/** Signals about the tokens found, with or without a second copy to compare against. */
function tokenSignals(tokens, compared) {
  const signals = [];
  const csp = tokens.filter((t) => t.label === "Content-Security-Policy nonce");
  const others = tokens.filter((t) => t.label !== "Content-Security-Policy nonce");
  const changed = others.filter((t) => t.comparison === "changed");
  const kept = others.filter((t) => t.comparison !== "changed");
  if (changed.length) {
    signals.push({ id: "token_changed", level: "block", text: `changes between two requests without cookies: ${tokenList(changed)}` });
  }
  if (kept.length) {
    const lifespan = kept.some((t) => WORDPRESS_NONCE.test(t.label))
      ? "; WordPress nonces stay valid for 12 to 24 hours, so a stored copy must expire within 12 hours"
      : "";
    const state = compared ? "the same in both requests" : "not compared (run with --twice to compare two requests)";
    signals.push({ id: "tokens", level: "caution", text: `holds ${tokenList(kept)}, ${state}${lifespan}` });
  }
  if (csp.some((t) => t.comparison === "changed")) {
    signals.push({
      id: "csp_nonce",
      level: "caution",
      text: "Content-Security-Policy nonce changes on every response: a stored copy reuses it, which weakens the policy unless the cache replaces it",
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------------------------------------------
// One route

const isHtmlType = (type) => /text\/html|application\/xhtml\+xml/i.test(type ?? "");

/** Whether the response is an HTML page the checks can read. */
export function isHtml(route) {
  if (route.headers["content-type"]) return isHtmlType(route.headers["content-type"]);
  return /^\s*(<!doctype html|<html|<head|<body|<!--)/i.test(route.body.slice(0, 1000)) || route.kind === "saved";
}

function headerCheck(route, signals) {
  if (!route.hasHeaders) return "response headers not given";
  const h = route.headers;
  const names = [...new Set(route.setCookieNames)];
  const harmless = signals.find((s) => s.id === "set_cookie_other");
  // "only for" holds when every cookie the response sets is a harmless one.
  const cookies = !names.length
    ? "no Set-Cookie"
    : harmless?.cookies.length === names.length
      ? `Set-Cookie only for ${[...new Set(harmless.cookies.map((c) => `${c.rule} (${c.what})`))].join(", ")}`
      : `Set-Cookie: ${names.join(", ")}`;
  return [cookies, h["cache-control"] ? `Cache-Control: ${h["cache-control"]}` : "no Cache-Control", h.vary ? `Vary: ${h.vary}` : "no Vary"].join("; ");
}

function pageCheck(signals, tokens, compared) {
  const has = (id) => signals.some((s) => s.id === id);
  const parts = [];
  parts.push(
    ["logged_in", "admin_bar", "logged_in_as", "mini_cart_items", "cart_count"].some(has)
      ? "login or cart markers found"
      : "no login, admin bar or cart markers",
  );
  parts.push(has("woo_page") ? "a WooCommerce cart, checkout or account page" : "no cart, checkout or account markers");
  if (!tokens.length) parts.push("no tokens");
  else {
    const same = tokens.length === 1 ? "the same in both requests" : "all the same in both requests";
    const state = compared ? (tokens.some((t) => t.comparison === "changed") ? "some changed" : same) : "not compared";
    parts.push(`${tokens.length} token${tokens.length === 1 ? "" : "s"} (${state})`);
  }
  return parts.join("; ");
}

function twiceCheck(changed) {
  if (!changed.length) return "no value changed between two requests without cookies";
  const values = changed.reduce((sum, c) => sum + c.count, 0);
  const tokens = changed.some((c) => c.token);
  return `${values} value${values === 1 ? "" : "s"} changed between two requests (${changed.slice(0, 5).map((c) => c.label).join(", ")})${tokens ? "" : ", none of them a token"}`;
}

/**
 * Runs every check on one loaded route and returns what the rest of the tool needs:
 * { route, status: "checked" | "not_checked", reason?, html, page, signals, tokens, changed, compared, facts,
 *   pageKind, servedFromCache, checks }.
 */
export function analyze(route, { allowCookies = [] } = {}) {
  if (route.error) return { route, status: "not_checked", reason: route.error };
  if (route.status !== null && !(route.status >= 200 && route.status < 300 && route.status !== 204 && route.status !== 205)) {
    return { route, status: "not_checked", reason: `HTTP ${route.status}` };
  }
  const fetched = route.kind === "fetched";
  const signals = headerSignals(route, { allowCookies });
  const html = isHtml(route);
  let page = null;
  let tokens = [];
  let changed = [];
  let facts = { wordpress: false, woocommerce: false, commentForm: false, passwordForm: false, recentlyViewed: false };
  let pageKind = null;
  const compared = Boolean(route.second && !route.second.error && html);
  if (html) {
    page = readPage(route.body);
    const found = pageSignals(page, { fetched });
    signals.push(...found.signals);
    facts = found.facts;
    pageKind = found.pageKind;
    tokens = findTokens(page);
    if (compared) changed = compareCopies(page, readPage(route.second.body), tokens);
    signals.push(...tokenSignals(tokens, compared));
    const tokenLike = changed.filter((c) => c.token);
    const other = changed.filter((c) => !c.token);
    if (tokenLike.length) {
      signals.push({
        id: "value_changed_token",
        level: "block",
        text: `changes between two requests without cookies: ${tokenLike.map((c) => c.label).join(", ")}`,
      });
    }
    if (other.length) {
      const count = other.reduce((sum, c) => sum + c.count, 0);
      signals.push({
        id: "values_changed",
        level: "caution",
        text: `${count} other value${count === 1 ? "" : "s"} changed between two requests (${other.slice(0, 5).map((c) => c.label).join(", ")})`,
      });
    }
  }
  if (route.second?.error) signals.push({ id: "second_failed", level: "info", text: `the second request failed: ${route.second.error}` });
  const servedFromCache = route.hasHeaders ? cacheHit(route.headers) : null;
  if (servedFromCache) signals.push({ id: "cache_hit", level: "info", text: `served from a cache (${servedFromCache})` });
  if (compared && servedFromCache && route.second.headers && cacheHit(route.second.headers)) {
    signals.push({
      id: "both_cached",
      level: "caution",
      text: "both copies came from a cache, so the comparison cannot show values that change per request",
    });
  }
  const checks = {
    headers: headerCheck(route, signals),
    page: html ? pageCheck(signals, tokens, compared) : "not an HTML page",
    ...(compared ? { twice: twiceCheck(changed) } : {}),
  };
  return {
    route,
    status: "checked",
    html,
    page,
    signals,
    tokens,
    changed,
    compared,
    facts,
    pageKind,
    servedFromCache,
    checks,
  };
}
