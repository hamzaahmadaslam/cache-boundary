// What Jev sees for one route (the state) and the three questions asked about it in one request. The state holds
// the page's path, title, body classes and visible text, the caching headers, the forms and the token names; token
// and cookie values are never included, and email addresses are replaced before anything is sent.
import { formLabel, redactEmails } from "./html.mjs";
import { choice, noul } from "./jev.mjs";
import { hideTokenValues, isTokenName, tokenShape } from "./tokens.mjs";

export const RULE_OPTIONS = ["cache", "cache_with_vary_on_cookie", "do_not_cache"];
/** Visible text sent per page, at most: the start and the end of a longer page. */
export const TEXT_LIMIT = 40_000;
export const TEXT_TOKEN_LIMIT = 10_000;
/** Estimated tokens a request may hold. TypeSafe allows 32k for the state plus the longest question. */
export const REQUEST_BUDGET = 24_000;
const STATE_HEADERS = ["cache-control", "vary", "pragma", "surrogate-control", "cdn-cache-control", "x-litespeed-cache-control"];
const MAX_FORMS = 12;
const MAX_FIELDS = 25;
const MAX_TOKENS = 40;

/**
 * Rough token count: four characters per token for ASCII text, one token per character for anything else, so
 * pages in other scripts are not underestimated.
 */
export function estimateTokens(text) {
  const s = String(text);
  let other = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) other++;
  return Math.ceil((s.length - other) / 4 + other);
}

function clipChars(text, limit) {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 7) / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  const headCut = head.lastIndexOf(" ") > half * 0.8 ? head.slice(0, head.lastIndexOf(" ")) : head;
  const tailCut = tail.indexOf(" ") >= 0 && tail.indexOf(" ") < half * 0.2 ? tail.slice(tail.indexOf(" ") + 1) : tail;
  return `${headCut}\n[...]\n${tailCut}`;
}

/** Keeps the start and the end of a long text, cut at spaces, with [...] between them. */
export function clip(text, limit = TEXT_LIMIT, tokenLimit = TEXT_TOKEN_LIMIT) {
  let out = clipChars(text, limit);
  let size = limit;
  while (estimateTokens(out) > tokenLimit && size > 200) {
    size = Math.floor((size * tokenLimit * 0.95) / estimateTokens(out));
    out = clipChars(text, size);
  }
  return out;
}

function comparisonText(token, compared) {
  if (!compared) return "not compared";
  return token.comparison === "changed" ? "changed between two requests" : "same in both requests";
}

function fieldText(field, tokenFields) {
  if (tokenFields.has(field.name)) return `${field.name} (${field.type}, ${tokenShape(field.value)})`;
  const visible = !["hidden", "submit", "button", "checkbox", "radio", "image", "reset", "select", "textarea", "password"].includes(field.type);
  if (visible && field.value) return `${field.name} (${field.type}, filled in: "${redactEmails(field.value).slice(0, 80)}")`;
  return `${field.name} (${field.type})`;
}

function actionPath(action) {
  if (!action) return "";
  try {
    const url = new URL(action, "https://placeholder.invalid/");
    return url.pathname;
  } catch {
    return "";
  }
}

/** The state for one analysed route. */
export function buildState(analysis, { twice = false } = {}) {
  const { route, page } = analysis;
  const state = {
    page: {
      ...(route.path ? { path: redactEmails(hideTokenValues(route.path)) } : {}),
      ...(route.status ? { status: route.status } : {}),
      title: redactEmails(page.title),
      body_classes: page.bodyClasses.join(" ").slice(0, 1000),
      text: redactEmails(clip(page.text)),
    },
  };
  if (route.hasHeaders) {
    const headers = {};
    for (const name of STATE_HEADERS) if (route.headers[name]) headers[name] = String(route.headers[name]).slice(0, 300);
    if (route.setCookieNames.length) headers["set-cookie"] = [...new Set(route.setCookieNames)].slice(0, 20).map((n) => `${n} (value not shown)`);
    state.headers = headers;
  }
  state.forms = page.forms.slice(0, MAX_FORMS).map((form, index) => {
    const tokenFields = new Set(form.fields.filter((f) => isTokenName(f.name) || analysis.tokens.some((t) => t.name === f.name)).map((f) => f.name));
    return {
      form: formLabel(form, index),
      method: form.method,
      ...(actionPath(form.action) ? { action: actionPath(form.action) } : {}),
      fields: form.fields.slice(0, MAX_FIELDS).map((field) => fieldText(field, tokenFields)),
    };
  });
  state.tokens = analysis.tokens
    .slice(0, MAX_TOKENS)
    .map((t) => `${t.name} in ${t.where} (${t.label}): ${tokenShape(t.values[0])}, ${comparisonText(t, analysis.compared)}`);
  if (twice) state.changed_between_requests = analysis.changed.slice(0, 30).map((c) => `${c.label}${c.count > 1 ? ` (${c.count} values)` : ""}`);
  return state;
}

function about({ fetched, hasHeaders, twice }) {
  const parts = [
    fetched
      ? "`page` is a web page as its server sent it to a visitor who was not logged in and sent no cookies."
      : "`page` is a web page saved from its server's response.",
    hasHeaders
      ? "`headers` holds the response headers that matter for caching, `forms` the page's forms, and `tokens` the values in the page that look like nonces or tokens (their values are not shown)."
      : "`forms` holds the page's forms, and `tokens` the values in the page that look like nonces or tokens (their values are not shown).",
  ];
  if (twice) parts.push("The page was requested twice; `changed_between_requests` lists where the two copies differed.");
  return parts.join(" ");
}

/** The three questions for one route. The ids are for this code only; they are not sent to the model. */
export function questionsFor(context) {
  const intro = about(context);
  return {
    visitor_content: noul(
      `${intro} Does \`page\` show content meant for one particular visitor, such as a person's name, a cart with items, an order, an address or an account detail?`,
      {
        true: "It shows a person's name or email address, a cart or mini cart with items, an order, an address, saved account details, or recommendations based on one visitor's history.",
        false: "Everything in it would be the same for every visitor who is not logged in: articles, products, prices, menus, an empty cart, and forms with empty fields.",
      },
    ),
    private_token: noul(
      `${intro} Does \`page\` hold a token or nonce that must not be shared between visitors, such as a session ID, a cart or login token, or a CSRF token or nonce that differs from one visitor to the next?`,
      {
        true: "A value in `tokens`, `forms` or `page` identifies or authorizes one visitor or one session, or `tokens` says a token changed between two requests.",
        false: "There is no such value, or the only values are the same for every visitor: version numbers, public keys for maps or analytics, and nonces that `tokens` says stayed the same in both requests.",
      },
    ),
    cache_rule: choice(
      `${intro} A full-page cache would store this copy of \`page\` and serve it to other visitors who are not logged in. Which rule should the cache follow for this page?`,
      {
        cache: "Store it and serve it to everyone: the page is the same for every visitor who is not logged in, such as an article, a product or category page, or a page whose forms are empty.",
        cache_with_vary_on_cookie: "Store one copy per value of a cookie: the page changes with a choice that a cookie remembers, such as a currency, a language, a region, or the password for a protected post.",
        do_not_cache: "Do not store it: the page shows or handles one visitor's own data or actions, such as a cart, checkout, account, order or login, or it holds a token for one visitor.",
      },
    ),
  };
}

/** The request body for one route, and its estimated input tokens. */
export function buildRequest(analysis, { model, twice = false }) {
  const { route } = analysis;
  const context = { fetched: route.kind === "fetched", hasHeaders: route.hasHeaders, twice: twice && route.kind === "fetched" };
  const body = { model, state: buildState(analysis, { twice: context.twice }), questions: questionsFor(context) };
  return { body, tokens: estimateTokens(JSON.stringify(body)) };
}
