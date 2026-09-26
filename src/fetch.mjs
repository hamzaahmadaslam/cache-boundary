// Fetches pages from the user's own site as a visitor without cookies, with these rules:
//   - http and https only, and never a URL with a user name or password in it;
//   - every hostname is resolved first, and refused when any of its addresses is private, loopback, link-local or
//     a cloud metadata address (src/address.mjs); the check runs before connecting and again on every redirect;
//   - the connection goes only to the addresses that passed the check (a second DNS answer cannot swap them);
//   - at most 3 redirects, and only to hosts that appear in the URLs the user gave;
//   - a time limit per request (10 s by default) and a 2 MB cap on the body, counted after decompression;
//   - a User-Agent that names the tool, one request at a time, and a short pause between requests.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { checkAddress } from "./address.mjs";

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const DELAY_MS = 500;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";

export class FetchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FetchError";
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The form hosts are compared in: lower case, without IPv6 brackets or a trailing dot. */
export function normalizeHost(hostname) {
  return String(hostname).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** Cookie names from Set-Cookie values. The values are dropped here and never kept, printed or sent. */
export function cookieNames(values) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  return list.map((line) => String(line).split(";")[0].split("=")[0].trim()).filter(Boolean);
}

/** Every address of a hostname. An IP address is returned as it is. */
export async function resolveHost(hostname) {
  const family = net.isIP(hostname);
  if (family) return [{ address: hostname, family }];
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

/**
 * Resolves `hostname` and returns its addresses, or throws a FetchError when it cannot be resolved or when any
 * address is private, loopback, link-local, a cloud metadata address or another special-purpose address.
 */
export async function checkedAddresses(hostname, resolve = resolveHost) {
  let addresses;
  const literal = net.isIP(hostname);
  try {
    // An IP address in the URL is checked as it is; it never goes through a resolver.
    addresses = literal ? [{ address: hostname, family: literal }] : await resolve(hostname);
  } catch (error) {
    throw new FetchError(`could not resolve ${hostname}${error?.code ? ` (${error.code})` : ""}`, "dns");
  }
  if (!Array.isArray(addresses) || !addresses.length) throw new FetchError(`could not resolve ${hostname}`, "dns");
  for (const { address } of addresses) {
    const check = checkAddress(address);
    if (!check.allowed) {
      const what = net.isIP(hostname) ? `${hostname} is` : `${hostname} resolves to ${address},`;
      throw new FetchError(`refused: ${what} ${check.reason}`, "blocked");
    }
  }
  return addresses.map(({ address, family }) => ({ address, family: family || net.isIP(address) }));
}

/**
 * A `lookup` function for http.request that answers only with the addresses checked before, so the socket connects
 * to an address that passed the check.
 */
export function pinnedLookup(addresses) {
  return function lookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const family = typeof options === "number" ? options : options?.family;
    const matching = family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses;
    if (!matching.length) {
      process.nextTick(callback, Object.assign(new Error(`no IPv${family} address for ${hostname}`), { code: "ENOTFOUND" }));
      return;
    }
    if (options?.all) process.nextTick(callback, null, matching.map(({ address, family: f }) => ({ address, family: f })));
    else process.nextTick(callback, null, matching[0].address, matching[0].family);
  };
}

/**
 * Reads a response body, decompressing gzip, deflate or br, and stops at `maxBytes` of decompressed data.
 * Resolves to { body: Buffer, truncated }.
 */
export function readBody(stream, encoding, maxBytes = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const name = String(encoding ?? "").trim().toLowerCase();
    let decoder = null;
    if (name === "gzip" || name === "x-gzip") decoder = zlib.createGunzip();
    else if (name === "deflate") decoder = zlib.createInflate();
    else if (name === "br") decoder = zlib.createBrotliDecompress();
    else if (name && name !== "identity") {
      stream.destroy?.();
      reject(new FetchError(`the response uses an encoding the tool cannot read (${name})`, "encoding"));
      return;
    }
    const source = decoder ? stream.pipe(decoder) : stream;
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (truncated) => {
      if (settled) return;
      settled = true;
      resolve({ body: Buffer.concat(chunks, size), truncated });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(new FetchError(`could not read the response: ${error?.message ?? error}`, "read"));
    };
    source.on("data", (chunk) => {
      if (settled) return;
      const room = maxBytes - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size += room;
        finish(true);
        stream.destroy?.();
        decoder?.destroy();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    source.on("end", () => finish(false));
    source.on("error", fail);
    if (decoder) stream.on("error", fail);
  });
}

function networkMessage(error) {
  const code = error?.code ?? "";
  if (code === "ECONNREFUSED") return "the connection was refused";
  if (code === "ECONNRESET") return "the connection was reset";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the host could not be resolved";
  if (/CERT|SSL|TLS/i.test(code)) return `the TLS certificate was not accepted (${code})`;
  return error?.message ? String(error.message) : "the request failed";
}

/** One GET request with node:http or node:https, connected only to `addresses`. */
export function httpRequest({ url, addresses, headers, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    let settled = false;
    let timer = null;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    let req;
    try {
      req = client.request(
        {
          hostname: normalizeHost(url.hostname),
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers,
          agent: false,
          lookup: pinnedLookup(addresses),
        },
        onResponse,
      );
    } catch (error) {
      done(new FetchError(networkMessage(error), "network"));
      return;
    }
    function onResponse(res) {
      const base = { status: res.statusCode, headers: res.headers };
      if (REDIRECT_STATUSES.has(res.statusCode) && res.headers.location) {
        res.resume();
        done(null, { ...base, body: Buffer.alloc(0), truncated: false });
        return;
      }
      readBody(res, res.headers["content-encoding"], maxBytes).then(
        ({ body, truncated }) => {
          if (truncated) req.destroy();
          done(null, { ...base, body, truncated });
        },
        (error) => {
          req.destroy();
          done(error);
        },
      );
    }
    timer = setTimeout(() => {
      done(new FetchError(`no complete answer within ${timeoutMs / 1000} s`, "timeout"));
      req.destroy();
    }, timeoutMs);
    req.on("error", (error) => done(error instanceof FetchError ? error : new FetchError(networkMessage(error), "network")));
    req.end();
  });
}

/** The text of a body, in the charset its Content-Type or a <meta charset> names, UTF-8 otherwise. */
export function decodeBody(buffer, contentType) {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentType ?? ""))?.[1];
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(buffer.subarray(0, 2048).toString("latin1"))?.[1];
  try {
    return new TextDecoder(fromHeader ?? fromMeta ?? "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

/** Waits so that requests to the site start at least `delayMs` after the previous one finished. */
export class Pacer {
  constructor(delayMs = DELAY_MS, wait = sleep) {
    this.delayMs = delayMs;
    this.wait = wait;
    this.last = null;
  }

  async turn() {
    if (this.last === null) return;
    const left = this.last + this.delayMs - Date.now();
    if (left > 0) await this.wait(left);
  }

  done() {
    this.last = Date.now();
  }
}

/**
 * Fetches one page as a visitor without cookies and returns
 * { url, status, headers, setCookieNames, body, truncated, redirects }. The Set-Cookie header is replaced by the
 * cookie names. Throws a FetchError when the URL cannot be fetched under the rules at the top of this file.
 */
export async function fetchPage(start, options) {
  const {
    allowedHosts,
    userAgent,
    timeoutMs = 10_000,
    maxBytes = MAX_BYTES,
    resolve = resolveHost,
    request = httpRequest,
    pacer = null,
  } = options;
  let url = new URL(start);
  const redirects = [];
  const setCookieNames = [];
  for (;;) {
    const host = normalizeHost(url.hostname);
    if (!allowedHosts.has(host)) {
      throw new FetchError(`redirects to ${url.href}, a host you did not list, so it was not followed`, "other_host");
    }
    const addresses = await checkedAddresses(host, resolve);
    if (pacer) await pacer.turn();
    let response;
    try {
      response = await request({
        url,
        addresses,
        headers: { "user-agent": userAgent, accept: ACCEPT, "accept-encoding": "gzip, deflate, br" },
        timeoutMs,
        maxBytes,
      });
    } finally {
      pacer?.done();
    }
    const headers = { ...response.headers };
    setCookieNames.push(...cookieNames(headers["set-cookie"]));
    delete headers["set-cookie"];
    const location = Array.isArray(headers.location) ? headers.location[0] : headers.location;
    if (REDIRECT_STATUSES.has(response.status) && location) {
      let next;
      try {
        next = new URL(location, url);
      } catch {
        throw new FetchError(`redirects to an address the tool cannot read: ${String(location).slice(0, 200)}`, "redirect");
      }
      next.hash = "";
      redirects.push({ from: url.href, status: response.status, to: next.href });
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new FetchError(`redirects to a ${next.protocol} address; only http and https are followed`, "redirect");
      }
      if (next.username || next.password) throw new FetchError("redirects to a URL with a user name or password", "redirect");
      if (redirects.length > MAX_REDIRECTS) throw new FetchError(`more than ${MAX_REDIRECTS} redirects`, "redirect");
      url = next;
      continue;
    }
    const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body ?? "");
    return {
      url: url.href,
      status: response.status,
      headers,
      setCookieNames,
      body: decodeBody(body, headers["content-type"]),
      bytes: body.length,
      truncated: Boolean(response.truncated),
      redirects,
    };
  }
}
