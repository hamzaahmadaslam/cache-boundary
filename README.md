# cache-boundary

Decides, route by route, whether a full-page cache may serve one anonymous visitor's copy of a page to everyone
else; for anyone who runs WordPress, WooCommerce or another site behind a page cache.

A page cache stores the HTML one visitor received and hands it to the next. When that page holds a nonce, a cart, a
greeting or a session cookie, the next visitor gets the first visitor's copy: a stale form token at best, someone
else's cart or name at worst. Cache plugins decide from URL patterns and cookie lists, so a custom members page or a
plugin that starts a session on every product page slips through. cache-boundary looks at what each route sends. It
checks the headers and the WordPress and WooCommerce markers in code, and asks Jev only what code cannot judge, such
as whether "Welcome back, Robin" belongs to one visitor. Jev answers with probabilities, so a route it is unsure
about goes to a review list instead of into a rule.

## What it checks in code

Each URL is fetched as a visitor without cookies (the rules are under
[What leaves your machine](#what-leaves-your-machine)), or a saved response is read from disk. With `--twice`, each
URL is fetched twice and the two copies are compared. Every signal has a level.

**Block**: the route is "do not cache", decided in code, and nothing about it is sent to TypeSafe.

- `Set-Cookie` for a session, login, cart or unknown cookie. Cookies set by a CDN or load balancer, such as
  `__cf_bm` and `AWSALB`, are noted and ignored, and `--allow-cookie` adds your own harmless ones.
- `Cache-Control` with `private`, `no-store` or `no-cache`; `Pragma: no-cache` without `Cache-Control`; `no-store` or
  `private` in `Surrogate-Control` or `CDN-Cache-Control`; `no-cache` or `private` in `X-LiteSpeed-Cache-Control`;
  `Vary: *`.
- The WooCommerce Store API's `Cart-Token` and `Nonce` response headers.
- A logged-in page: the `logged-in` or `admin-bar` body class, the `#wpadminbar` element, or a comment form that names
  the logged-in user.
- A WooCommerce cart, checkout or account page: the `woocommerce-cart`, `woocommerce-checkout`, `woocommerce-account`,
  `woocommerce-order-received` and `woocommerce-order-pay` body classes, the cart and checkout blocks, the cart form,
  the empty-cart message, the checkout form, the account navigation and the WooCommerce login form.
- A mini cart that lists products or shows a count above 0 (the classic `.cart-contents .count` markup, the mini-cart
  block badge and common cart-count class names).
- With `--twice`: a token that changes between two requests without cookies.

**Vary**: at most one stored copy per value of a cookie.

- `Vary: Cookie`, or a response that sets a language or currency cookie (`pll_language`, `wp-wpml_current_language`,
  `wmc_current_currency` and similar).
- A currency switcher (from class names, or the plugin folders of common currency switchers), a country or region
  switcher, or a password-protected post (`wp-postpass_*`).

**Caution**: printed next to a cache verdict.

- Tokens that did not change: WordPress nonces (`_wpnonce`), the REST API nonce, the WooCommerce Store API nonce,
  other nonces in scripts, CSRF fields and meta tags, `data-*` nonce attributes and links with a nonce in the query
  string. WordPress nonces stay valid for 12 to 24 hours, so a stored copy that holds one must expire within 12 hours.
  Without `--twice`, tokens are marked "not compared".
- WooCommerce cart fragments and geolocation, the recently viewed products widget, `Vary: User-Agent`,
  `Vary: Accept-Language` and other `Vary` headers, and values other than tokens that change between two requests.

The tool also notes when a response came from a cache (`Age`, `X-Cache`, `CF-Cache-Status`, `Cache-Status` and
similar headers).

## How it uses Jev

Jev is TypeSafe AI's System One model: it answers typed questions with probabilities and writes no text.

Each route that code did not decide gets one request with three questions about the same state: the page's path,
status, title, body classes and visible text, its caching headers, its forms, and its tokens by name and shape.

| Question                                                                                                                                                                  | Type   | What it decides                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------- |
| Does `page` show content meant for one particular visitor, such as a person's name, a cart with items, an order, an address or an account detail?                           | noul   | content that belongs to one visitor               |
| Does `page` hold a token or nonce that must not be shared between visitors, such as a session ID, a cart or login token, or a CSRF token or nonce that differs from one visitor to the next? | noul   | a token that must not be shared                   |
| A full-page cache would store this copy of `page` and serve it to other visitors who are not logged in. Which rule should the cache follow for this page?                   | choice | cache, cache with vary on cookie, or do not cache |

The full wording, with what counts as a yes and a no for each answer, is in `src/questions.mjs`, and
`--dry-run --json` prints every request body.

The verdict is made in code with one threshold, `--threshold` (default 0.8). A yes/no answer counts as yes at or above
it and as no at or below 1 minus it; the rule counts when its confidence is at or above it.

| Verdict        | When                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| do not cache   | a block signal in code; a confident yes to either question (unless the rule confidently says to store the page, which sends it to review); or the rule confidently says do not cache |
| vary on cookie | both questions are a confident no, and the rule confidently says vary, or it says cache and code found a vary signal                                              |
| cache          | both questions are a confident no, the rule confidently says cache, and code found no block or vary signal                                                        |
| review         | everything else, with the reasons                                                                                                                                 |

Cache and vary also need complete evidence: the response headers, and a body under the 2 MB cap. A saved page without
its headers can be found unsafe but never safe. Every cache verdict lists the evidence behind it: the `Set-Cookie`,
`Cache-Control` and `Vary` headers, the markers checked, the tokens found, and the comparison of two requests when
`--twice` was used. The report prints the probabilities next to every verdict, and every word in it comes from your
pages or from fixed text in the code.

The suggested rules come from the confident verdicts only: paths not to cache (WooCommerce cart, checkout and
account pages with everything below them), cookies that should skip the cache (WordPress login, WooCommerce session
and cart, comment authors, password-protected posts, recently viewed products, and any blocking cookie seen), and
cookies to keep one stored copy per value of. They are plain lists, not settings for a particular cache. A logged-in
page or a full cart in the answer to a request without cookies does not become a path rule: the stored copy is the
problem, so the report says to purge it and to skip the cache for login and cart cookies.

## Install

Needs Node.js 20 or later. There are no dependencies.

```sh
npm install -g github:hamzaahmadaslam/cache-boundary
```

## Usage

```sh
export TYPESAFE_API_KEY=<your-key>
cache-boundary https://example.com/ https://example.com/shop/ https://example.com/cart/
```

In PowerShell, set the key with `$env:TYPESAFE_API_KEY = "<your-key>"`.

```sh
cache-boundary --urls routes.txt              # one URL per line; # starts a comment
cache-boundary --urls routes.txt --twice      # fetch each URL twice and compare the copies
cache-boundary saved/                         # saved responses instead of live URLs
cache-boundary --urls routes.txt --dry-run    # fetch and check in code; send nothing to TypeSafe
cache-boundary --urls routes.txt --json > report.json
```

| Option                  | Default | What it does                                                                                                     |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `--urls <file>`         |         | Read more URLs from a text file, one per line.                                                                   |
| `--twice`               | off     | Fetch each URL twice and compare the copies. A token that changes means the page must not be shared.            |
| `--allow-cookie <name>` |         | Treat a cookie as harmless. Repeat it for more; a trailing `*` matches a prefix.                                 |
| `--threshold <p>`       | `0.8`   | Confidence needed to act on Jev's answers. Above 0.5, at most 1.                                                 |
| `--timeout <seconds>`   | `10`    | Time limit for each request, to your site and to TypeSafe. TypeSafe's 429 and 529 answers are retried three times. |
| `--json`                | off     | Print JSON: every route, its signals, the raw probabilities and the rules.                                       |
| `--dry-run`             | off     | Fetch and check in code, then print the plan, one route's questions and the token estimate. Needs no key.        |

Environment: `TYPESAFE_API_KEY` (needed unless `--dry-run`) and `TYPESAFE_MODEL` (default `jev-latest`).

Exit codes: `0` when no problem was found; `1` when a request without cookies got a logged-in page or a cart with
items, or a cache served a route that must not be cached, so it can fail a CI job; `2` on an error or when no route
could be checked. Routes in review do not change the exit code.

### Saved responses

To check a staging site behind a login, or a page as your browser sees it, save the response and pass the file:

```sh
curl -sS -D cart.headers -o cart.html https://example.com/cart/
curl -sS -i https://example.com/cart/ > cart.html      # or with the headers at the top of the file
```

A folder is read for every `.html` and `.htm` file below it. The headers come from `page.headers` next to
`page.html`, or from the top of the file; with several header blocks (redirects), the last response counts and every
`Set-Cookie` is kept. The path used in the rules comes from the page's canonical link or `og:url`. A saved copy may
come from a browser that was logged in, so login and cart markers in it make the copy "do not cache" with a note to
save it again without cookies, not a leak.

## Example

`examples/site` holds nine saved responses from a made-up shop on example.com, written for this example. The
probabilities below come from `examples/fixture-answers.json`: they were written by hand, not recorded from TypeSafe,
and show the report format. Your numbers will differ. `node examples/run.mjs` prints this report without a key or a
network call.

```text
cache-boundary: 9 routes (9 saved responses)
Model jev-1.13.0, 6 requests, 4,854 input tokens, threshold 0.8; 3 routes decided in code

do not cache 4   vary 1   cache 2   review 2

Do not cache
  blue-hoodie.html (/product/blue-hoodie/)  decided in code, nothing sent
      sets wp_woocommerce_session_* (WooCommerce session)
  cart.html (/cart/)  decided in code, nothing sent
      WooCommerce cart page (body class woocommerce-cart)
      Cache-Control forbids a shared copy: no-cache, must-revalidate, max-age=0, no-store, private (the no-cache headers WordPress sends)
  members.html (/pattern-club/)
      Jev: shows content for one visitor
      Jev: visitor content 0.95 | private token 0.08 | rule: do not cache 0.93, cache 0.05 (confidence 0.90)
  my-account.html (/my-account/)  decided in code, nothing sent
      WooCommerce account page (body class woocommerce-account)
      Cache-Control forbids a shared copy: no-cache, must-revalidate, max-age=0, no-store, private (the no-cache headers WordPress sends)

Cache one copy per cookie value
  shop.html (/shop/)
      Jev: the page changes with a cookie
      currency switcher (class currency-switcher)
      Jev: visitor content 0.06 | private token 0.05 | rule: vary on cookie 0.90, cache 0.08 (confidence 0.85)
      headers: no Set-Cookie; Cache-Control: public, max-age=300; Vary: Accept-Encoding
      page: no login, admin bar or cart markers; no cart, checkout or account markers; no tokens

Cache: one stored copy for every visitor
  hello-world.html (/journal/how-we-pick-our-cotton/)
      Jev: visitor content 0.03 | private token 0.04 | rule: cache 0.96 (confidence 0.94)
      headers: no Set-Cookie; Cache-Control: public, max-age=600; Vary: Accept-Encoding
      page: no login, admin bar or cart markers; no cart, checkout or account markers; no tokens
  index.html (/)
      Jev: visitor content 0.04 | private token 0.06 | rule: cache 0.95 (confidence 0.92)
      headers: no Set-Cookie; Cache-Control: public, max-age=600; Vary: Accept-Encoding
      page: no login, admin bar or cart markers; no cart, checkout or account markers; no tokens
      caution: WooCommerce cart fragments (wc_cart_fragments_params) refresh the mini cart after the page loads: store only a copy with an empty cart

Review: check these yourself
  about.html (/about/)
      no response headers, so Set-Cookie, Cache-Control and Vary are unknown (save them with curl -D)
      Jev: visitor content 0.03 | private token 0.03 | rule: cache 0.96 (confidence 0.94)
  events.html (/workshops/)
      unclear whether it shows one visitor's content; unclear which cache rule fits
      Jev: visitor content 0.46 | private token 0.05 | rule: cache 0.48, vary on cookie 0.44, do not cache 0.08 (confidence 0.22)

Suggested rules (from the confident verdicts; check them against your cache's own settings)
  Do not cache these paths:
    /cart/ and everything below it         WooCommerce cart page
    /my-account/ and everything below it   WooCommerce account page
    /pattern-club/                         Jev: shows content for one visitor
    /product/blue-hoodie/                  sets wp_woocommerce_session_* on a visit
  Skip the cache for requests with these cookies:
    wordpress_logged_in_*       WordPress login
    wp_woocommerce_session_*    WooCommerce session
    woocommerce_items_in_cart   WooCommerce cart
    woocommerce_cart_hash       WooCommerce cart
    comment_author_*            comment forms fill in the commenter's name and email
  Keep one stored copy per value of:
    the cookie your currency switcher sets   currency switcher, on /shop/

Verdicts come from checks in code first, then from Jev's answers at or above the threshold (0.8).
Routes in review had answers below the threshold, answers that disagreed, or missing evidence.
```

The product page starts a WooCommerce session for a visitor with an empty cart, so code decides it, as it decides
the cart and account pages. The members page greets a named person and shows a renewal date, which only Jev's answers
catch. The shop has a currency switcher, so it gets one stored copy per currency. The about page looks fine but was
saved without its headers, so it stays in review, and the workshops page sits near the middle on two answers. The
same run with `--json` is in `examples/report.json`, and the dry run in `examples/dry-run.txt`.

## What leaves your machine

cache-boundary contacts two kinds of hosts and nothing else: no telemetry, no update checks.

**Your site**, for the URLs you give:

- only the hosts in those URLs; a redirect to any other host is reported and not followed;
- `GET` requests with the User-Agent `cache-boundary/1.0.0 (+https://github.com/hamzaahmadaslam/cache-boundary)`, no
  cookies and no credentials;
- before each connection, and again on every redirect (at most 3), the hostname is resolved, and the host is refused
  if any of its addresses is private, loopback, link-local, a cloud metadata address (such as 169.254.169.254,
  fd00:ec2::254 and 100.100.100.200) or another special-purpose address, IPv4 or IPv6. The connection then goes only
  to the addresses that passed the check;
- one request at a time, half a second apart, each with a 10-second limit, reading at most 2 MB of each page;
- `--dry-run` still fetches the URLs.

Saved responses are read from disk, and nothing is fetched for them.

**api.typesafe.ai**, only with a key and without `--dry-run`, only `https://api.typesafe.ai/v1/systemone`, one
request for each route that code did not decide:

- the page's path (not the host name), HTTP status, title, body classes and visible text, up to 40,000 characters
  (the start and the end of a longer page, less for text in scripts other than Latin), with email addresses replaced by
  `[email address]`;
- the `Cache-Control`, `Vary`, `Pragma`, `Surrogate-Control`, `CDN-Cache-Control` and `X-LiteSpeed-Cache-Control`
  headers, and the names of the cookies the response sets;
- each form's id or class, method, action path and field names, with the text a visible field was filled in with
  (email addresses replaced, password fields never);
- the name of each token, where it sits and its shape, such as "10 hex characters";
- with `--twice`, the names of the places where the two copies differed;
- the fixed question text, the model name, and your API key in the `Authorization` header.

Never sent: cookie values, token values, password fields, the host name, and anything about a route decided in code.
The tool writes nothing to disk.

## Limits

- It judges the copy a visitor without cookies gets. It does not see what a logged-in visitor or a visitor with a cart
  gets; the cookie rules cover those visitors. To check their view, save the page from your browser and pass the file.
- The markers cover WordPress core, WooCommerce and common theme and plugin markup. A plugin that shows a greeting or
  a cart in its own markup is left to Jev, which may be unsure.
- A page that varies by query string (WooCommerce geolocation) or by device (`Vary: User-Agent`) gets a caution; the
  tool does not check your cache key.
- Prices or content chosen from the visitor's IP address, with no cookie or URL change, cannot be seen from one
  request.
- A response from a cache is noticed only through common headers (`Age`, `X-Cache`, `CF-Cache-Status`,
  `Cache-Status` and others). A cache that sends none of them goes unnoticed.
- Without `--twice`, tokens are not compared. Two requests half a second apart can share a value that changes later,
  such as a WordPress nonce after its 12-hour tick.
- English is where Jev is most accurate. Text written to steer a model, such as an instruction hidden in a page, can
  move its answers.
- The tool reports and never changes your cache. Check a sample of verdicts on your own site before you rely on a
  threshold, and read the review list yourself.

## Token use

Routes decided in code send nothing and use no tokens. Every other route is one request, and the questions and page
structure add about 750 tokens to it. By the tool's own estimate (four characters per token for English text):

| Run                                                         | Requests | Input tokens     |
| ----------------------------------------------------------- | -------- | ---------------- |
| The example: 9 saved pages, 3 decided in code               | 6        | about 4,900      |
| 50 routes with about 8,000 characters of visible text each  | 50       | about 137,000    |
| 500 such routes                                             | 500      | about 1,370,000  |

A page with 40,000 characters of text or more uses about 10,700 tokens. `--dry-run` prints the estimate for your own
routes before anything is sent.

## License

MIT. Made by [Hamza Ahmad Aslam](https://hamzaahmadaslam.com), WordPress and web performance engineer.
