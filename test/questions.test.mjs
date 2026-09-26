import "./helpers/no-network.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { buildRequest, buildState, clip, estimateTokens, questionsFor, TEXT_TOKEN_LIMIT } from "../src/questions.mjs";
import { analyze } from "../src/signals.mjs";

const CONTACT = [
  '<!doctype html><html><head><title>Contact - Example</title></head><body class="page page-id-3">',
  "<h1>Contact</h1><p>Write to hello@example.com.</p>",
  '<form id="contact" method="post" action="https://example.com/contact/?sent=1">',
  '<input type="text" name="your-name" value="Robin"><input type="email" name="your-email" value="robin@example.com">',
  '<input type="hidden" name="_wpnonce" value="a1b2c3d4e5"><input type="password" name="pw" value="hunter22">',
  '<button type="submit">Send</button></form></body></html>',
].join("");

const saved = {
  kind: "saved",
  input: "contact.html",
  label: "contact.html",
  url: "https://example.com/contact/",
  path: "/contact/",
  status: 200,
  headers: { "content-type": "text/html", "cache-control": "public, max-age=60", vary: "Accept-Encoding" },
  hasHeaders: true,
  setCookieNames: ["pll_language"],
  body: CONTACT,
  truncated: false,
  redirects: [],
  second: null,
};

const ABOUT_SAVED =
  "`page` is a web page saved from its server's response. `headers` holds the response headers that matter for caching, `forms` the page's forms, and `tokens` the values in the page that look like nonces or tokens (their values are not shown).";

test("the request body for one route: the state and the three questions (snapshot)", () => {
  const { body, tokens } = buildRequest(analyze(saved), { model: "jev-latest" });
  assert.deepEqual(body, {
    model: "jev-latest",
    state: {
      page: { path: "/contact/", status: 200, title: "Contact - Example", body_classes: "page page-id-3", text: "Contact\nWrite to [email address].\nSend" },
      headers: { "cache-control": "public, max-age=60", vary: "Accept-Encoding", "set-cookie": ["pll_language (value not shown)"] },
      forms: [
        {
          form: "#contact",
          method: "post",
          action: "/contact/",
          fields: ['your-name (text, filled in: "Robin")', 'your-email (email, filled in: "[email address]")', "_wpnonce (hidden, 10 hex characters)", "pw (password)"],
        },
      ],
      tokens: ["_wpnonce in form #contact (WordPress nonce): 10 hex characters, not compared"],
    },
    questions: {
      visitor_content: {
        type: "noul",
        instructions: `${ABOUT_SAVED} Does \`page\` show content meant for one particular visitor, such as a person's name, a cart with items, an order, an address or an account detail?`,
        criteria: {
          true: "It shows a person's name or email address, a cart or mini cart with items, an order, an address, saved account details, or recommendations based on one visitor's history.",
          false: "Everything in it would be the same for every visitor who is not logged in: articles, products, prices, menus, an empty cart, and forms with empty fields.",
        },
      },
      private_token: {
        type: "noul",
        instructions: `${ABOUT_SAVED} Does \`page\` hold a token or nonce that must not be shared between visitors, such as a session ID, a cart or login token, or a CSRF token or nonce that differs from one visitor to the next?`,
        criteria: {
          true: "A value in `tokens`, `forms` or `page` identifies or authorizes one visitor or one session, or `tokens` says a token changed between two requests.",
          false: "There is no such value, or the only values are the same for every visitor: version numbers, public keys for maps or analytics, and nonces that `tokens` says stayed the same in both requests.",
        },
      },
      cache_rule: {
        type: "choice",
        instructions: `${ABOUT_SAVED} A full-page cache would store this copy of \`page\` and serve it to other visitors who are not logged in. Which rule should the cache follow for this page?`,
        criteria: {
          cache: "Store it and serve it to everyone: the page is the same for every visitor who is not logged in, such as an article, a product or category page, or a page whose forms are empty.",
          cache_with_vary_on_cookie: "Store one copy per value of a cookie: the page changes with a choice that a cookie remembers, such as a currency, a language, a region, or the password for a protected post.",
          do_not_cache: "Do not store it: the page shows or handles one visitor's own data or actions, such as a cart, checkout, account, order or login, or it holds a token for one visitor.",
        },
      },
    },
  });
  assert.equal(tokens, estimateTokens(JSON.stringify(body)));
});

test("nothing secret reaches the state: no token, cookie or password values, no email addresses, no host", () => {
  const { body } = buildRequest(analyze(saved), { model: "jev-latest" });
  const sent = JSON.stringify(body);
  for (const secret of ["a1b2c3d4e5", "hunter22", "robin@example.com", "hello@example.com", "example.com/contact"]) {
    assert.ok(!sent.includes(secret), `${secret} is not sent`);
  }
  // A token or an email address in the query string of the page's path is replaced too; the rest of the path stays.
  const preview = buildState(analyze({ ...saved, path: "/contact/?preview_nonce=a1b2c3d4e5&preview=true&from=robin@example.com" }));
  assert.equal(preview.page.path, "/contact/?preview_nonce=[value not shown]&preview=true&from=[email address]");
});

test("the visible text keeps the body when the optional </head> is left out or a script holds \"<head>\"", () => {
  const text = (body) => buildState(analyze({ ...saved, body })).page.text;
  assert.equal(text("<html><head><title>Club</title><body><p>Welcome back, Robin.</p></body></html>"), "Welcome back, Robin.");
  assert.equal(
    text('<html><head><title>Club</title></head><body><p>Hello</p><script>var tpl = "<head>";</script><p>Welcome back, Robin.</p></body></html>'),
    "Hello\nWelcome back, Robin.",
  );
});

test("the question wording follows the input: fetched without cookies, saved without headers, fetched twice", () => {
  const fetched = questionsFor({ fetched: true, hasHeaders: true, twice: true });
  assert.ok(fetched.visitor_content.instructions.startsWith("`page` is a web page as its server sent it to a visitor who was not logged in and sent no cookies."));
  assert.match(fetched.private_token.instructions, /The page was requested twice; `changed_between_requests` lists where the two copies differed\./);
  const bare = questionsFor({ fetched: false, hasHeaders: false, twice: false });
  assert.ok(!bare.cache_rule.instructions.includes("`headers`"), "no headers are mentioned when none were saved");
  assert.deepEqual(Object.keys(bare.cache_rule.criteria), ["cache", "cache_with_vary_on_cookie", "do_not_cache"]);
});

test("long pages keep their start and end; text in other scripts is cut to fit the token budget", () => {
  const long = `${"start ".repeat(5000)}middle ${"end ".repeat(10000)}`;
  const cut = clip(long, 1000);
  assert.ok(cut.length <= 1000);
  assert.ok(cut.startsWith("start start"));
  assert.ok(cut.trimEnd().endsWith("end end"));
  assert.ok(cut.includes("\n[...]\n"));
  const cjk = `${String.fromCodePoint(0x4e2d, 0x6587, 0x9875, 0x9762)} `.repeat(20000);
  assert.ok(estimateTokens(clip(cjk)) <= TEXT_TOKEN_LIMIT);
  assert.equal(clip("short text"), "short text");
});
