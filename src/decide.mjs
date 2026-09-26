// Turns the checks made in code and Jev's answers into one verdict per route, finds the problems that set the exit
// code, and builds the suggested rules. The order is fixed:
//   1. a "block" signal decides "do not cache" in code, and nothing about that route is sent to TypeSafe;
//   2. otherwise Jev's three answers count only at or above the threshold (yes) or at or below 1 minus it (no);
//   3. a "vary" signal from code raises a cache verdict to "vary on a cookie";
//   4. "cache" and "vary" also need complete evidence: response headers, and a body under the 2 MB cap.
// Everything else goes to review.
import { COPY_SIGNALS, PAGE_KINDS } from "./signals.mjs";
import { RULE_OPTIONS } from "./questions.mjs";

export const DEFAULT_THRESHOLD = 0.8;

// Rounding keeps float noise (1 - 0.8 is 0.19999999999999996) from moving an answer that sits on the threshold.
const round = (value) => Math.round(value * 1e6) / 1e6;
const isProbability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** The three answers for a route, or null when any is missing or malformed. */
export function readAnswers(answers) {
  const visitor = answers?.visitor_content?.noul;
  const token = answers?.private_token?.noul;
  const rule = answers?.cache_rule;
  if (!isProbability(visitor) || !isProbability(token)) return null;
  if (!rule || !RULE_OPTIONS.includes(rule.choice) || !isProbability(rule.confidence)) return null;
  if (!rule.probabilities || typeof rule.probabilities !== "object") return null;
  return { visitor, token, rule: { choice: rule.choice, confidence: rule.confidence, probabilities: rule.probabilities } };
}

/**
 * The verdict from Jev's answers alone: cache, vary, do-not-cache or review, with reason codes.
 *   do-not-cache  a confident yes on either yes/no question (unless the rule confidently says to store it), or a
 *                 confident do_not_cache rule
 *   cache, vary   a confident rule of that kind, with both yes/no answers confidently no
 *   review        anything else
 */
export function jevVerdict(answer, threshold = DEFAULT_THRESHOLD) {
  const { visitor, token, rule } = answer;
  const yes = (p) => round(p) >= threshold;
  const no = (p) => round(1 - p) >= threshold;
  const sure = round(rule.confidence) >= threshold;
  if (yes(visitor) || yes(token)) {
    if (sure && rule.choice !== "do_not_cache") return { verdict: "review", reasons: ["answers_disagree"] };
    return { verdict: "do-not-cache", reasons: [yes(visitor) && "visitor_content", yes(token) && "private_token"].filter(Boolean) };
  }
  if (sure && rule.choice === "do_not_cache") return { verdict: "do-not-cache", reasons: ["rule_do_not_cache"] };
  if (sure && no(visitor) && no(token)) {
    return rule.choice === "cache" ? { verdict: "cache", reasons: [] } : { verdict: "vary", reasons: ["rule_vary"] };
  }
  const reasons = [];
  if (!yes(visitor) && !no(visitor)) reasons.push("unsure_visitor");
  if (!yes(token) && !no(token)) reasons.push("unsure_token");
  if (!sure) reasons.push("unsure_rule");
  return { verdict: "review", reasons: reasons.length ? reasons : ["answers_disagree"] };
}

/** What is missing before a route may be called safe to store: [] when nothing is. */
function missingEvidence(analysis) {
  const missing = [];
  if (!analysis.route.hasHeaders) missing.push("no_headers");
  if (analysis.route.truncated) missing.push("truncated");
  return missing;
}

/**
 * The verdict for one analysed route. `asked` says whether a request went to Jev; `answer` is its parsed answers.
 * Returns { verdict, decidedBy, reasons }, where verdict is do-not-cache, vary, cache, review or not-checked.
 */
export function decideRoute(analysis, { asked, answer, threshold = DEFAULT_THRESHOLD }) {
  if (analysis.status !== "checked") return { verdict: "not-checked", decidedBy: "code", reasons: [] };
  if (analysis.signals.some((s) => s.level === "block")) return { verdict: "do-not-cache", decidedBy: "code", reasons: [] };
  if (!analysis.html) return { verdict: "review", decidedBy: "code", reasons: ["not_html"] };
  if (analysis.tooLarge) return { verdict: "review", decidedBy: "code", reasons: ["too_large"] };
  if (!asked || !answer) return { verdict: "review", decidedBy: "jev", reasons: ["no_answer"] };
  const jev = jevVerdict(answer, threshold);
  let { verdict } = jev;
  let decidedBy = "jev";
  if (analysis.signals.some((s) => s.level === "vary") && (verdict === "cache" || verdict === "vary")) {
    verdict = "vary";
    decidedBy = "code and jev";
  }
  if (verdict === "cache" || verdict === "vary") {
    const missing = missingEvidence(analysis);
    if (missing.length) return { verdict: "review", decidedBy, reasons: missing };
  }
  return { verdict, decidedBy, reasons: jev.reasons };
}

const LOGIN_SIGNALS = new Set(["logged_in", "admin_bar", "logged_in_as"]);

/** Whether every reason a route was decided in code is about this copy (a login or a cart), so no path rule fits. */
function onlyCopySignals(analysis) {
  const block = analysis.signals.filter((s) => s.level === "block");
  return block.length > 0 && block.every((s) => COPY_SIGNALS.has(s.id));
}

/**
 * Problems that set exit code 1, for fetched routes only (a saved copy may come from a logged-in browser):
 *   leak    a request without cookies got a logged-in page or a cart with items
 *   cached  a cache served a route that must not be cached
 */
export function problemsOf(analysis, verdict) {
  const out = [];
  if (analysis.status !== "checked" || analysis.route.kind !== "fetched") return out;
  const leaks = analysis.signals.filter((s) => s.leak);
  if (leaks.length) {
    out.push({
      id: "leak",
      text: `a request without cookies got one visitor's page: ${leaks.map((s) => s.text).join("; ")}; purge the stored copy and make the cache skip requests with login or cart cookies`,
    });
  }
  if (analysis.servedFromCache && verdict === "do-not-cache" && !(leaks.length && onlyCopySignals(analysis))) {
    out.push({ id: "cached", text: `served from a cache (${analysis.servedFromCache}) although it must not be cached` });
  }
  return out;
}

const CODE_REASONS = [
  ["woo_page", null],
  ["logged_in", "shows a logged-in page"],
  ["admin_bar", "shows the WordPress admin bar"],
  ["logged_in_as", "names the logged-in user"],
  ["mini_cart_items", "shows a cart with products"],
  ["cart_count", "shows a cart with items"],
  ["set_cookie", null],
  ["token_changed", "a token changes on every request"],
  ["value_changed_token", "a token changes on every request"],
  ["cart_token", "sends a Store API cart token"],
  ["nonce_header", "sends a Store API nonce"],
  ["cache_control", "Cache-Control forbids a shared copy"],
  ["surrogate-control", "Surrogate-Control forbids a shared copy"],
  ["cdn-cache-control", "CDN-Cache-Control forbids a shared copy"],
  ["cloudflare-cdn-cache-control", "Cloudflare-CDN-Cache-Control forbids a shared copy"],
  ["litespeed", "X-LiteSpeed-Cache-Control forbids a shared copy"],
  ["vary_all", "Vary: *"],
];

/** The order in which block signals are listed: what the page is before what its headers say. */
export const BLOCK_ORDER = CODE_REASONS.map(([id]) => id);

const JEV_REASONS = {
  visitor_content: "Jev: shows content for one visitor",
  private_token: "Jev: holds a token that must not be shared",
  rule_do_not_cache: "Jev: the rule is do not cache",
};

/** A short reason for a do-not-cache verdict, for the rules list. */
export function shortReason(result) {
  const { analysis } = result;
  if (result.decidedBy === "code") {
    for (const [id, text] of CODE_REASONS) {
      const signal = analysis.signals.find((s) => s.id === id && s.level === "block");
      if (!signal) continue;
      if (id === "woo_page") return PAGE_KINDS[signal.pageKind];
      if (id === "set_cookie") return `sets ${[...new Set(signal.cookies.map((c) => c.rule))].join(", ")} on a visit`;
      if (id === "cache_control") {
        const value = String(analysis.route.headers["cache-control"] ?? "");
        const found = ["private", "no-store", "no-cache"].filter((d) => new RegExp(`(^|[\\s,])${d}($|[\\s,=])`, "i").test(value));
        return found.length ? `Cache-Control: ${found.join(", ")}` : "Pragma: no-cache";
      }
      return text;
    }
    return analysis.signals.find((s) => s.level === "block")?.text ?? "a check in code";
  }
  return result.reasons.map((r) => JEV_REASONS[r]).filter(Boolean).join("; ") || "Jev: do not cache";
}

/**
 * Suggested rules from the confident verdicts:
 *   paths   do not cache these paths (WooCommerce cart, checkout and account pages with everything below them)
 *   bypass  skip the cache for requests with these cookies
 *   vary    keep one stored copy per value of these cookies
 */
export function buildRules(results) {
  const facts = { wordpress: false, woocommerce: false, commentForm: false, passwordForm: false, recentlyViewed: false };
  const seen = new Map();
  const paths = new Map();
  const vary = new Map();
  const addVary = (cookie, reason, where) => {
    if (!vary.has(cookie)) vary.set(cookie, { cookie, reason, paths: [] });
    const entry = vary.get(cookie);
    if (!entry.paths.includes(where)) entry.paths.push(where);
  };
  for (const result of results) {
    const { analysis } = result;
    if (analysis.status !== "checked") continue;
    for (const key of Object.keys(facts)) facts[key] ||= analysis.facts[key];
    for (const signal of analysis.signals) {
      if (signal.level === "block" && signal.cookies) for (const c of signal.cookies) if (!seen.has(c.rule)) seen.set(c.rule, c.what);
      if (LOGIN_SIGNALS.has(signal.id)) facts.wordpress = true;
      else if (COPY_SIGNALS.has(signal.id)) facts.woocommerce = true;
    }
    const route = analysis.route;
    if (result.verdict === "do-not-cache" && !(result.decidedBy === "code" && onlyCopySignals(analysis))) {
      const below = Boolean(analysis.pageKind) && Boolean(route.path);
      const path = route.path ? (below ? route.path.split("?")[0] : route.path) : null;
      const key = path ?? `file:${route.label}`;
      if (!paths.has(key)) paths.set(key, { path, label: route.label, below, reason: shortReason(result) });
    }
    if (result.verdict === "vary") {
      const where = route.path ?? route.label;
      const choices = analysis.signals.filter((s) => s.id === "set_cookie_choice").flatMap((s) => s.cookies);
      const has = (id) => analysis.signals.some((s) => s.id === id);
      if (choices.length) for (const c of choices) addVary(c.rule, c.what, where);
      else if (has("currency_switcher")) addVary("the cookie your currency switcher sets", "currency switcher", where);
      else if (has("region_switcher")) addVary("the cookie your country or region switcher sets", "country or region switcher", where);
      else if (has("vary_cookie")) addVary("the cookies named in the site's Vary: Cookie header", "Vary: Cookie", where);
      else if (!has("password_form")) addVary("the cookie that holds the visitor's choice (not found)", "Jev: the page changes with a cookie", where);
    }
  }
  const bypass = new Map();
  if (facts.wordpress) bypass.set("wordpress_logged_in_*", "WordPress login");
  if (facts.woocommerce) {
    bypass.set("wp_woocommerce_session_*", "WooCommerce session");
    bypass.set("woocommerce_items_in_cart", "WooCommerce cart");
    bypass.set("woocommerce_cart_hash", "WooCommerce cart");
  }
  if (facts.commentForm) bypass.set("comment_author_*", "comment forms fill in the commenter's name and email");
  if (facts.passwordForm) bypass.set("wp-postpass_*", "password-protected posts");
  if (facts.recentlyViewed) bypass.set("woocommerce_recently_viewed", "recently viewed products");
  for (const [rule, what] of seen) if (!bypass.has(rule)) bypass.set(rule, what);
  return {
    paths: [...paths.values()].sort((a, b) => (a.path ?? `~${a.label}`).localeCompare(b.path ?? `~${b.label}`)),
    bypass: [...bypass].map(([cookie, reason]) => ({ cookie, reason })),
    vary: [...vary.values()],
  };
}
