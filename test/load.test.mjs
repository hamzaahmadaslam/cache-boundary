import "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UserError } from "../src/errors.mjs";
import { collectInputs, hostsOf, parseHeaderText, readSaved } from "../src/load.mjs";

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cache-boundary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("URLs come from the arguments and a --urls file; comments, blank lines, fragments and repeats are dropped", (t) => {
  const dir = tempDir(t);
  const list = path.join(dir, "routes.txt");
  writeFileSync(list, ["# routes on the shop", "https://example.com/shop/", "", "  https://example.com/cart/#top  ", "https://example.com/"].join("\r\n"));
  const inputs = collectInputs(["https://example.com/", "HTTPS://WWW.Example.com/About"], list);
  assert.deepEqual(inputs.urls, ["https://example.com/", "https://www.example.com/About", "https://example.com/shop/", "https://example.com/cart/"]);
  assert.deepEqual(inputs.files, []);
  assert.deepEqual([...hostsOf(inputs.urls)], ["example.com", "www.example.com"]);
});

test("inputs the tool cannot use are refused with one plain sentence", (t) => {
  const dir = tempDir(t);
  const list = path.join(dir, "routes.txt");
  writeFileSync(list, "https://example.com/\nexample.com/no-scheme\n");
  writeFileSync(path.join(dir, "notes.md"), "# notes");
  const cases = [
    [["ftp://example.com/file"], undefined, /^URL: only http and https URLs can be checked, not ftp:$/],
    [["https://user:secret@example.com/"], undefined, /remove the user name and password from the URL for example\.com/],
    [[], list, /routes\.txt line 2: "example\.com\/no-scheme" is not a valid URL\.$/],
    [[list], undefined, /to read URLs from a file, use --urls/],
    [[path.join(dir, "notes.md")], undefined, /give URLs, saved \.html files/],
    [[path.join(dir, "missing")], undefined, /there is no such file or folder\.$/],
    [[dir], undefined, /holds no \.html or \.htm files\.$/],
  ];
  for (const [args, urls, message] of cases) {
    assert.throws(() => collectInputs(args, urls), (e) => e instanceof UserError && message.test(e.message), message.source);
  }
});

test("saved headers: with curl -D and redirects, the final response wins and every Set-Cookie name is kept", () => {
  const saved = parseHeaderText(
    [
      "HTTP/1.1 301 Moved Permanently",
      "Location: https://example.com/shop/",
      "Set-Cookie: first_hop=abc; path=/",
      "",
      "HTTP/2 200 ",
      "content-type: text/html; charset=UTF-8",
      "Cache-Control: public,",
      "  max-age=300",
      "set-cookie: pll_language=en; path=/",
      "vary: Accept-Encoding",
      "vary: Cookie",
      "",
    ].join("\r\n"),
  );
  assert.deepEqual(saved, {
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "public, max-age=300", vary: "Accept-Encoding, Cookie" },
    setCookieNames: ["first_hop", "pll_language"],
  });
  assert.deepEqual(parseHeaderText("content-type: text/html\nvary: Cookie\n"), {
    status: null,
    headers: { "content-type": "text/html", vary: "Cookie" },
    setCookieNames: [],
  });
  assert.equal(parseHeaderText("\n\n"), null);
});

test("saved responses: a .headers file beside the page, curl -i output, or no headers at all", (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, "shop"));
  mkdirSync(path.join(dir, ".hidden"));
  const page = (canonical) => `<!doctype html><html><head><link rel="canonical" href="${canonical}"></head><body><p>Hi</p></body></html>`;
  writeFileSync(path.join(dir, "shop", "cart.html"), page("https://example.com/cart/"));
  writeFileSync(path.join(dir, "shop", "cart.headers"), "HTTP/2 200\ncache-control: no-store\n");
  writeFileSync(
    path.join(dir, "home.htm"),
    `HTTP/1.1 302 Found\r\nLocation: /\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html\r\nSet-Cookie: PHPSESSID=abc\r\n\r\n${page("https://example.com/?lang=en")}`,
  );
  writeFileSync(path.join(dir, "about.html"), "<html><body><p>About</p></body></html>");
  writeFileSync(path.join(dir, ".hidden", "skip.html"), "<p>skip</p>");
  const inputs = collectInputs([dir]);
  assert.deepEqual(
    inputs.files.map((f) => f.label),
    ["about.html", "home.htm", "shop/cart.html"],
  );
  const [about, home, cart] = inputs.files.map(readSaved);
  assert.deepEqual(
    { hasHeaders: about.hasHeaders, status: about.status, path: about.path, url: about.url },
    { hasHeaders: false, status: null, path: null, url: null },
  );
  assert.equal(home.status, 200);
  assert.deepEqual(home.setCookieNames, ["PHPSESSID"]);
  assert.equal(home.path, "/?lang=en");
  assert.ok(home.body.startsWith("<!doctype html>"), "the headers are not part of the body");
  assert.deepEqual({ status: cart.status, headers: cart.headers, path: cart.path, kind: cart.kind }, {
    status: 200,
    headers: { "cache-control": "no-store" },
    path: "/cart/",
    kind: "saved",
  });
});
