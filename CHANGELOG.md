# Changelog

## Unreleased

### Fixed

- The visible text sent to Jev is no longer empty for a page that leaves out the optional `</head>` end tag before
  `<body>`, and no longer stops at an inline script that holds the string `<head>`.
- An answer from TypeSafe that is not JSON, or that holds no answers, stops the run with a plain message instead of an
  unexpected error.
- The headers check says "Set-Cookie only for" only when every cookie the response sets is harmless, and names each
  cookie once.
- A WooCommerce account page found by `woocommerce-MyAccount-content`, and a mini cart found by `mini_cart_item`, are
  reported with the class that was found.
- `--help` says that exit code 2 also means that no route could be checked.

### Security

- The page's path sent to TypeSafe no longer holds token values or email addresses from its query string: a token's
  value is sent as `[value not shown]` and an email address as `[email address]`, as the README says.

## 1.0.0 - 2026-09-26

First release.
