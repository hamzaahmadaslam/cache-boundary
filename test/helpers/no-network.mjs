// Imported first by every test file: every way the tool could reach the network throws instead. The tests pass their
// own resolver, site transport and TypeSafe fetch, all of which answer from memory.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";

const refuse = (what) => () => {
  throw new Error(`Tests must not use the network (${what}).`);
};

globalThis.fetch = refuse("fetch");
http.request = refuse("http.request");
http.get = refuse("http.get");
https.request = refuse("https.request");
https.get = refuse("https.get");
dns.lookup = refuse("dns.lookup");
dns.promises.lookup = refuse("dns.promises.lookup");

/** A public address for the fake resolver. Nothing ever connects to it. */
export const PUBLIC = [{ address: "93.184.215.14", family: 4 }];
export const publicResolver = async () => PUBLIC;

/**
 * A fake site: answers each request from `pages` (URL -> response, or a function of the call count for that URL).
 * Unknown URLs get a 404. Records every call with the headers the tool sent.
 */
export function fakeSite(pages) {
  const calls = [];
  const request = async ({ url, addresses, headers }) => {
    calls.push({ url: url.href, addresses, headers });
    const entry = pages[url.href];
    const page = typeof entry === "function" ? entry(calls.filter((c) => c.url === url.href).length) : entry;
    if (!page) return { status: 404, headers: { "content-type": "text/html" }, body: Buffer.from("<p>Not found</p>"), truncated: false };
    return { status: page.status ?? 200, headers: page.headers ?? {}, body: Buffer.from(page.body ?? ""), truncated: Boolean(page.truncated) };
  };
  return { request, calls };
}

/** A fixture TypeSafe answer with the three answers for one route. */
export function answers({ visitor = 0.05, token = 0.05, rule = { cache: 0.95, cache_with_vary_on_cookie: 0.03, do_not_cache: 0.02 } } = {}) {
  const options = Object.keys(rule);
  const choice = options.reduce((best, o) => (rule[o] > rule[best] ? o : best));
  const confidence = Math.round(Math.min(1, Math.max(0, (options.length * rule[choice] - 1) / (options.length - 1))) * 100) / 100;
  return {
    model: "jev-1.13.0",
    answers: {
      visitor_content: { type: "noul", noul: visitor },
      private_token: { type: "noul", noul: token },
      cache_rule: { type: "choice", choice, probabilities: rule, confidence },
    },
    usage: { input_tokens: 1000, output_tokens: 0 },
  };
}
