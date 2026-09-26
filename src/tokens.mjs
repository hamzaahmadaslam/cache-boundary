// Values in a page that look like nonces, CSRF tokens or session IDs: where they sit, what they are called, how they
// look, and, with --twice, whether they change between two requests without cookies. The values stay in memory for
// that comparison; the rest of the tool only ever prints or sends a token's name and shape.
import { formLabel } from "./html.mjs";

export const TOKEN_NAME = /nonce|token|csrf|xsrf|authenticity|verification|security|session|sessid|form_?key/i;
// Words that make a token-like name describe something else: nonce_life, csrfParam, tokenType, wcStoreApiNonceTimestamp.
const NOT_TOKEN_WORDS = new Set(
  "time timeout timestamp stamp expires expiry expiration ttl life lifetime length count version ver name field param params url header action enabled required label text type storage".split(
    " ",
  ),
);
const words = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Whether a name (a field, key, attribute or parameter) is one that holds a token. Only the last key counts. */
export const isTokenName = (name) => TOKEN_NAME.test(name) && !words(name.replace(/.*\./, "")).some((w) => NOT_TOKEN_WORDS.has(w));

/** Whether a value can be a token: 6 to 1,024 characters without spaces, with a digit or at least 20 long. */
function tokenValue(value) {
  const v = String(value ?? "").trim();
  if (v.length < 6 || v.length > 1024 || !/^[A-Za-z0-9+/=_.:~-]+$/.test(v)) return false;
  return /\d/.test(v) || v.length >= 20;
}

/** Whether a string looks random: hex, or a mix of letters and digits, 8 characters or more. */
export function looksRandom(value) {
  if (value.length < 8 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, "").length;
  const letters = value.replace(/[^A-Za-z]/g, "").length;
  if (/^[0-9a-f]+$/i.test(value)) return digits >= 2 && letters >= 1;
  return digits >= 2 && letters >= 2;
}

/** How a token looks, without its value: "10 hex characters", "32 letters and digits". */
export function tokenShape(value) {
  const v = String(value);
  const n = v.length.toLocaleString("en-US");
  if (/^\d+$/.test(v)) return `${n} digits`;
  if (/^[0-9a-f]+$/i.test(v)) return `${n} hex characters`;
  if (/^[A-Za-z0-9]+$/.test(v)) return `${n} letters and digits`;
  return `${n} characters`;
}

function tokenLabel(name, where) {
  if (where.endsWith("nonce attribute")) return "Content-Security-Policy nonce";
  if (/wpnonce/i.test(name)) return "WordPress nonce";
  if (/storeApiNonce/i.test(name)) return "WooCommerce Store API nonce";
  if (/createNonceMiddleware|wpApiSettings/.test(name)) return "WordPress REST API nonce";
  if (/^woocommerce-[\w-]*nonce$|^wc_\w+_params\./i.test(name)) return "WooCommerce nonce";
  if (/csrf|xsrf|authenticity|verification/i.test(name)) return "CSRF token";
  if (/nonce/i.test(name)) return "nonce";
  if (/sess/i.test(name)) return "session ID";
  return "token";
}

const KEY_VALUE = /["']?([A-Za-z_$][\w$-]{0,80})["']?\s*[:=]\s*["']([^"'\s\\]{6,1024})["']/g;
const DECLARATION = /(?:\b(?:var|let|const)\s+|\bwindow\.)([A-Za-z_$][\w$]*)\s*=/g;
const NONCE_OBJECT = /["']?((?:[A-Za-z_$][\w$-]*)?(?:nonces|tokens))["']?\s*:\s*\{([^{}]{0,4000})\}/gi;
const NONCE_MIDDLEWARE = /createNonceMiddleware\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Every value in the page that looks like a nonce, CSRF token or session ID:
 * [{ key, where, name, label, values }]. `values` stay in memory for --twice and are never printed or sent.
 */
export function findTokens(page) {
  const list = [];
  const add = (where, name, value) => {
    const key = `${where}|${name}`;
    const found = list.find((t) => t.key === key);
    if (found) found.values.push(value);
    else list.push({ key, where, name, label: tokenLabel(name, where), values: [value] });
  };
  page.forms.forEach((form, index) => {
    const label = formLabel(form, index);
    const where = label.startsWith("form") ? label : `form ${label}`;
    for (const field of form.fields) {
      const named = isTokenName(field.name) && tokenValue(field.value);
      const random = field.type === "hidden" && field.value.length >= 16 && looksRandom(field.value);
      if (named || random) add(where, field.name, field.value);
    }
  });
  for (const script of page.scripts) {
    const declarations = [...script.matchAll(DECLARATION)].map((m) => ({ at: m.index, name: m[1] }));
    const owner = (at) => declarations.filter((d) => d.at < at).pop()?.name;
    for (const m of script.matchAll(KEY_VALUE)) {
      if (!isTokenName(m[1]) || !tokenValue(m[2])) continue;
      const parent = owner(m.index);
      add("inline script", parent && parent !== m[1] ? `${parent}.${m[1]}` : m[1], m[2]);
    }
    for (const m of script.matchAll(NONCE_OBJECT)) {
      for (const inner of m[2].matchAll(KEY_VALUE)) {
        if (tokenValue(inner[2]) && !isTokenName(inner[1])) add("inline script", `${m[1]}.${inner[1]}`, inner[2]);
      }
    }
    for (const m of script.matchAll(NONCE_MIDDLEWARE)) add("inline script", "wp.apiFetch.createNonceMiddleware", m[1]);
  }
  for (const { tag, name, value } of page.data) if (tokenValue(value)) add(`${name} attribute on <${tag}>`, name, value);
  for (const meta of page.metas) {
    if (meta.name && isTokenName(meta.name) && tokenValue(meta.content)) add("meta tag", meta.name, meta.content);
  }
  for (const { tag, attribute, value } of page.links) {
    for (const m of value.matchAll(/[?&;]([^=&#;]+)=([^&#;]*)/g)) {
      if (isTokenName(m[1]) && tokenValue(m[2])) add(`link (${attribute} of <${tag}>)`, m[1], m[2]);
    }
  }
  for (const { tag, value } of page.nonceAttributes) add(`<${tag}> nonce attribute`, "nonce", value);
  return list;
}

/** A URL path with the values of its token query parameters (such as _wpnonce) replaced, so they are never sent. */
export function hideTokenValues(path) {
  return String(path).replace(/([?&;])([^=&#;]+)=([^&#;]*)/g, (match, separator, name, value) =>
    isTokenName(name) && tokenValue(value) ? `${separator}${name}=[value not shown]` : match,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Two copies (--twice)

const RANDOM_STRING = /[A-Za-z0-9_-]{8,}/g;

/**
 * Where a value sits: the attribute, query parameter or script key just before it (for value= and content=, the
 * name, id or property of the same tag), or "text".
 */
function contextLabel(html, index) {
  const before = html.slice(Math.max(0, index - 200), index);
  const attribute = /([A-Za-z_:][\w:.-]*)\s*=\s*["']?[^"'<>\s=&?]*$/.exec(before);
  if (attribute) {
    if (/^(value|content)$/i.test(attribute[1])) {
      const named = /\b(?:name|id|property)\s*=\s*["']([^"']+)["']/i.exec(before.slice(before.lastIndexOf("<")));
      if (named) return named[1];
    }
    return attribute[1];
  }
  const key = /["']?([A-Za-z_$][\w$-]*)["']?\s*:\s*["']?$/.exec(before);
  if (key) return key[1];
  return "text";
}

function randomStrings(html) {
  const found = new Map();
  for (const m of html.matchAll(RANDOM_STRING)) if (!found.has(m[0]) && looksRandom(m[0])) found.set(m[0], m.index);
  return found;
}

/**
 * Compares the tokens of two copies of a page (marking each "same" or "changed") and counts, by where they sit, the
 * other random-looking values of the first copy that the second one does not have: [{ label, token, count }].
 */
export function compareCopies(first, second, tokens) {
  const again = findTokens(second);
  for (const token of tokens) {
    const other = again.find((t) => t.key === token.key);
    token.comparison = other && other.values.join("\n") === token.values.join("\n") ? "same" : "changed";
  }
  for (const other of again) {
    if (!tokens.some((t) => t.key === other.key)) tokens.push({ ...other, comparison: "changed" });
  }
  const known = new Set(tokens.flatMap((t) => t.values));
  const before = randomStrings(first.noComments);
  const after = randomStrings(second.noComments);
  const changed = new Map();
  for (const [value, index] of before) {
    if (after.has(value) || known.has(value)) continue;
    const label = contextLabel(first.noComments, index);
    if (!changed.has(label)) changed.set(label, { label, token: isTokenName(label), count: 0 });
    changed.get(label).count++;
  }
  return [...changed.values()];
}
