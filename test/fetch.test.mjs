import { PUBLIC, fakeSite, publicResolver } from "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import zlib from "node:zlib";
import { fetchPage, FetchError, httpRequest, MAX_BYTES, Pacer, readBody } from "../src/fetch.mjs";

const hosts = (...names) => new Set(names);
const redirect = (to, status = 301) => ({ status, headers: { location: to } });
const html = (body) => ({ headers: { "content-type": "text/html; charset=utf-8" }, body });
const noRequest = () => assert.fail("no request may be made");

test("a host that resolves to a private, loopback or metadata address is refused before any request", async () => {
  const cases = [
    ["https://intranet.example.com/", [{ address: "10.0.0.7", family: 4 }], /^refused: intranet\.example\.com resolves to 10\.0\.0\.7, a private address$/],
    ["https://meta.example.com/", [{ address: "169.254.169.254", family: 4 }], /a cloud metadata address$/],
    ["https://six.example.com/", [{ address: "::1", family: 6 }], /a loopback address$/],
    ["https://mixed.example.com/", [...PUBLIC, { address: "192.168.0.10", family: 4 }], /192\.168\.0\.10, a private address$/],
  ];
  for (const [url, addresses, message] of cases) {
    const options = { allowedHosts: hosts(new URL(url).hostname), userAgent: "t", resolve: async () => addresses, request: noRequest };
    await assert.rejects(fetchPage(url, options), (e) => e instanceof FetchError && e.code === "blocked" && message.test(e.message));
  }
  // IP addresses in the URL are checked without DNS.
  await assert.rejects(
    fetchPage("http://127.0.0.1:8080/", { allowedHosts: hosts("127.0.0.1"), userAgent: "t", request: noRequest }),
    /refused: 127\.0\.0\.1 is a loopback address$/,
  );
  await assert.rejects(
    fetchPage("http://[::ffff:169.254.169.254]/", { allowedHosts: hosts("::ffff:a9fe:a9fe"), userAgent: "t", request: noRequest }),
    /cloud metadata/,
  );
});

test("every redirect is checked again; at most 3 are followed, only to listed hosts and only to http or https", async () => {
  const resolved = [];
  const resolve = async (host) => {
    resolved.push(host);
    return host === "internal.example.com" ? [{ address: "10.1.1.1", family: 4 }] : PUBLIC;
  };
  const three = fakeSite({
    "http://example.com/a": redirect("https://example.com/b"),
    "https://example.com/b": redirect("/c", 302),
    "https://example.com/c": redirect("https://www.example.com/d", 308),
    "https://www.example.com/d": html("<p>done</p>"),
  });
  const page = await fetchPage("http://example.com/a", {
    allowedHosts: hosts("example.com", "www.example.com"),
    userAgent: "t",
    resolve,
    request: three.request,
  });
  assert.equal(page.url, "https://www.example.com/d");
  assert.deepEqual(
    page.redirects.map((r) => r.status),
    [301, 302, 308],
  );
  assert.deepEqual(resolved, ["example.com", "example.com", "example.com", "www.example.com"]);

  const four = fakeSite({
    "https://example.com/1": redirect("/2"),
    "https://example.com/2": redirect("/3"),
    "https://example.com/3": redirect("/4"),
    "https://example.com/4": redirect("/5"),
  });
  await assert.rejects(
    fetchPage("https://example.com/1", { allowedHosts: hosts("example.com"), userAgent: "t", resolve, request: four.request }),
    /more than 3 redirects$/,
  );
  assert.equal(four.calls.length, 4);

  const elsewhere = fakeSite({ "https://example.com/go": redirect("https://tracker.example.net/x") });
  await assert.rejects(
    fetchPage("https://example.com/go", { allowedHosts: hosts("example.com"), userAgent: "t", resolve, request: elsewhere.request }),
    (e) => e.code === "other_host" && /tracker\.example\.net\/x, a host you did not list/.test(e.message),
  );
  assert.equal(elsewhere.calls.length, 1);

  const inside = fakeSite({ "https://example.com/in": redirect("https://internal.example.com/admin") });
  await assert.rejects(
    fetchPage("https://example.com/in", {
      allowedHosts: hosts("example.com", "internal.example.com"),
      userAgent: "t",
      resolve,
      request: inside.request,
    }),
    /refused: internal\.example\.com resolves to 10\.1\.1\.1, a private address/,
  );
  assert.equal(inside.calls.length, 1, "the private host is never requested");

  const ftp = fakeSite({ "https://example.com/f": redirect("ftp://example.com/file") });
  await assert.rejects(
    fetchPage("https://example.com/f", { allowedHosts: hosts("example.com"), userAgent: "t", resolve, request: ftp.request }),
    /only http and https are followed/,
  );
});

test("the tool names itself, sends no cookies, and keeps only cookie names from Set-Cookie", async () => {
  const site = fakeSite({
    "https://example.com/": {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": ["PHPSESSID=secret-value-1; path=/", "wp_woocommerce_session_ab=t_secret; HttpOnly"],
      },
      body: "<p>hello</p>",
    },
  });
  const userAgent = "cache-boundary/1.0.0 (+https://github.com/hamzaahmadaslam/cache-boundary)";
  const page = await fetchPage("https://example.com/", { allowedHosts: hosts("example.com"), userAgent, resolve: publicResolver, request: site.request });
  const sent = site.calls[0].headers;
  assert.equal(sent["user-agent"], userAgent);
  assert.equal(sent.cookie, undefined);
  assert.equal(sent["accept-encoding"], "gzip, deflate, br");
  assert.deepEqual(site.calls[0].addresses, PUBLIC);
  assert.deepEqual(page.setCookieNames, ["PHPSESSID", "wp_woocommerce_session_ab"]);
  assert.equal(page.headers["set-cookie"], undefined);
  assert.equal(page.body, "<p>hello</p>");
  assert.ok(!JSON.stringify(page).includes("secret"), "cookie values are dropped");
});

test("bodies stop at 2 MB after decompression; gzip, deflate and br are read; other encodings are refused", async () => {
  const capped = await readBody(Readable.from([zlib.gzipSync(Buffer.alloc(3 * 1024 * 1024, 97))]), "gzip");
  assert.equal(capped.truncated, true);
  assert.equal(capped.body.length, MAX_BYTES);
  const plain = await readBody(Readable.from([Buffer.from("hello")]), undefined);
  assert.deepEqual({ text: plain.body.toString(), truncated: plain.truncated }, { text: "hello", truncated: false });
  assert.equal((await readBody(Readable.from([zlib.brotliCompressSync(Buffer.from("brotli"))]), "br")).body.toString(), "brotli");
  assert.equal((await readBody(Readable.from([zlib.deflateSync(Buffer.from("deflate"))]), "deflate")).body.toString(), "deflate");
  await assert.rejects(readBody(Readable.from([Buffer.from("x")]), "zstd"), /encoding the tool cannot read \(zstd\)/);
});

test("httpRequest connects only to the checked addresses and gives up after the time limit", async (t) => {
  const original = http.request;
  t.after(() => {
    http.request = original;
  });
  let options;
  http.request = (opts) => {
    options = opts;
    const req = new EventEmitter();
    req.end = () => {};
    req.destroy = () => {};
    return req;
  };
  await assert.rejects(
    httpRequest({ url: new URL("http://example.com/slow?x=1"), addresses: PUBLIC, headers: { "user-agent": "t" }, timeoutMs: 30, maxBytes: 100 }),
    (e) => e instanceof FetchError && e.code === "timeout" && e.message === "no complete answer within 0.03 s",
  );
  assert.equal(options.hostname, "example.com");
  assert.equal(options.path, "/slow?x=1");
  assert.equal(options.agent, false);
  const all = await new Promise((resolve) => options.lookup("example.com", { all: true }, (error, list) => resolve(list)));
  assert.deepEqual(all, PUBLIC);
  const one = await new Promise((resolve) => options.lookup("example.com", {}, (error, address, family) => resolve([address, family])));
  assert.deepEqual(one, ["93.184.215.14", 4]);
  const six = await new Promise((resolve) => options.lookup("example.com", { family: 6 }, (error) => resolve(error?.code)));
  assert.equal(six, "ENOTFOUND");

  http.request = (opts, onResponse) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      const res = new PassThrough();
      res.statusCode = 200;
      res.headers = { "content-encoding": "gzip", "content-type": "text/html" };
      onResponse(res);
      res.end(zlib.gzipSync(Buffer.from("<p>zipped</p>")));
    };
    return req;
  };
  const response = await httpRequest({ url: new URL("http://example.com/"), addresses: PUBLIC, headers: {}, timeoutMs: 1000, maxBytes: 100 });
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), "<p>zipped</p>");
});

test("requests to the site are paced: each waits for the pause after the one before", async () => {
  const waits = [];
  const pacer = new Pacer(500, async (ms) => {
    waits.push(ms);
  });
  const site = fakeSite({
    "https://example.com/a": redirect("/b"),
    "https://example.com/b": html("<p>b</p>"),
  });
  await fetchPage("https://example.com/a", { allowedHosts: hosts("example.com"), userAgent: "t", resolve: publicResolver, request: site.request, pacer });
  assert.equal(site.calls.length, 2);
  assert.equal(waits.length, 1, "the second request waited");
  assert.ok(waits[0] > 400 && waits[0] <= 500, `waited ${waits[0]} ms`);
});
