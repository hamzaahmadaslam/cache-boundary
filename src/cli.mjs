// The command line: parses options, loads the routes, and prints the report, the JSON or the dry run.
// main() takes its environment, output streams, TypeSafe fetch and site transport as arguments, so tests run it
// without a network.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_TIMEOUT_SECONDS, loadRoutes, planChecks, runChecks } from "./check.mjs";
import { DEFAULT_THRESHOLD } from "./decide.mjs";
import { UserError } from "./errors.mjs";
import { DELAY_MS, httpRequest, Pacer, resolveHost } from "./fetch.mjs";
import { DEFAULT_MODEL, JevError } from "./jev.mjs";
import { collectInputs } from "./load.mjs";
import { dryRunJson, formatDryRun, formatReport, toJson } from "./report.mjs";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const USER_AGENT = `cache-boundary/${VERSION} (+https://github.com/hamzaahmadaslam/cache-boundary)`;

export const USAGE = `Usage: cache-boundary <url | page.html | folder>... [options]

Decides, route by route, whether a full-page cache may serve one anonymous visitor's copy of a page to everyone.

Arguments:
  url                    a page on your own site (http or https), fetched as a visitor without cookies
  page.html              a saved response, with its headers in page.headers next to it or at the top (curl -i)
  folder                 every .html and .htm file in a folder, read as saved responses

Options:
  --urls <file>          read more URLs from a text file, one per line (# starts a comment)
  --twice                fetch each URL twice and compare the copies for values that change per request
  --allow-cookie <name>  treat a cookie as harmless (repeat for more; a trailing * matches a prefix)
  --threshold <p>        confidence needed to act on Jev's answers, above 0.5 and up to 1 (default ${DEFAULT_THRESHOLD})
  --timeout <seconds>    time limit for each request, to your site and to TypeSafe (default ${DEFAULT_TIMEOUT_SECONDS})
  --json                 print JSON instead of the report
  --dry-run              fetch and check in code, print the questions and a token estimate; send nothing to TypeSafe
  -h, --help             show this help
  -v, --version          show the version

Environment:
  TYPESAFE_API_KEY       your TypeSafe API key (not needed for --dry-run)
  TYPESAFE_MODEL         the model to use (default ${DEFAULT_MODEL})

Exit codes: 0 no problem found, 1 a cache served a page it must not or a visitor without cookies got
one visitor's page, 2 an error or no route could be checked.
`;

// A cookie name (RFC 6265 token characters, without *), optionally followed by one * that matches any ending.
const COOKIE_PATTERN = /^[!#$%&'+.^_`|~0-9A-Za-z-]+[*]?$/;

function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        urls: { type: "string" },
        twice: { type: "boolean", default: false },
        "allow-cookie": { type: "string", multiple: true, default: [] },
        threshold: { type: "string" },
        timeout: { type: "string" },
        json: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    throw new UserError(`${error.message} Run cache-boundary --help for the options.`);
  }
  const { values, positionals } = parsed;
  if (values.help || values.version) return { help: values.help, version: values.version };
  if (!positionals.length && values.urls === undefined) {
    throw new UserError("Give at least one URL, saved .html file or folder, or --urls <file>. Run cache-boundary --help for usage.");
  }
  const threshold = values.threshold === undefined ? DEFAULT_THRESHOLD : Number(values.threshold);
  if (!(threshold > 0.5 && threshold <= 1)) {
    throw new UserError(`--threshold must be a number above 0.5 and at most 1, not "${values.threshold}".`);
  }
  const timeoutSeconds = values.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values.timeout);
  if (!(timeoutSeconds > 0 && timeoutSeconds <= 600)) {
    throw new UserError(`--timeout must be a number of seconds above 0 and at most 600, not "${values.timeout}".`);
  }
  for (const name of values["allow-cookie"]) {
    if (!COOKIE_PATTERN.test(name)) {
      throw new UserError(`--allow-cookie takes a cookie name, optionally ending in *, not "${name}".`);
    }
  }
  return {
    positionals,
    urlsFile: values.urls,
    twice: values.twice,
    allowCookies: values["allow-cookie"],
    threshold,
    timeoutSeconds,
    json: values.json,
    dryRun: values["dry-run"],
  };
}

/**
 * Runs the tool and returns the exit code: 0 no problem found, 1 at least one problem, 2 an error or no route could
 * be checked.
 * `io` can replace the environment, the output streams, the fetch used for TypeSafe, and the resolver, transport
 * and pause used for the site.
 */
export async function main(argv, io = {}) {
  const {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    fetchImpl = globalThis.fetch,
    resolve = resolveHost,
    request = httpRequest,
    wait,
  } = io;
  const write = (stream, text) => stream.write(text.endsWith("\n") ? text : `${text}\n`);
  try {
    const options = parseOptions(argv);
    if (options.help || options.version) {
      write(stdout, options.help ? USAGE : VERSION);
      return 0;
    }
    const inputs = collectInputs(options.positionals, options.urlsFile);
    if (!inputs.urls.length && !inputs.files.length) throw new UserError(`${options.urlsFile} holds no URLs.`);
    const apiKey = env.TYPESAFE_API_KEY?.trim();
    if (!options.dryRun && !apiKey) {
      throw new UserError(
        "TYPESAFE_API_KEY is not set. Get a key at https://typesafe.ai and export it first, or use --dry-run to see what would be sent.",
      );
    }
    if (options.twice && !inputs.urls.length) write(stderr, "cache-boundary: --twice applies to URLs; saved responses are read once.");
    const model = env.TYPESAFE_MODEL?.trim() || DEFAULT_MODEL;
    const meta = { version: VERSION, model, twice: options.twice && inputs.urls.length > 0 };

    const fetchProgress = stderr.isTTY && inputs.urls.length
      ? (done, total) => stderr.write(`\rfetched ${done} of ${total} URLs${done === total ? "\n" : ""}`)
      : undefined;
    const routes = await loadRoutes(inputs, {
      twice: meta.twice,
      userAgent: USER_AGENT,
      timeoutMs: options.timeoutSeconds * 1000,
      resolve,
      request,
      pacer: new Pacer(DELAY_MS, wait),
      onProgress: fetchProgress,
    });
    const plan = planChecks(routes, { allowCookies: options.allowCookies, model, twice: meta.twice });

    if (options.dryRun) {
      write(stdout, options.json ? JSON.stringify(dryRunJson(plan, meta), null, 2) : formatDryRun(plan, meta));
      return 0;
    }

    const progress = stderr.isTTY && plan.requests.length
      ? (done, total) => stderr.write(`\rchecked ${done} of ${total} routes with Jev${done === total ? "\n" : ""}`)
      : undefined;
    const result = await runChecks(plan, {
      threshold: options.threshold,
      apiKey,
      model,
      timeoutSeconds: options.timeoutSeconds,
      fetchImpl,
      onProgress: progress,
    });
    write(stdout, options.json ? JSON.stringify(toJson(result, meta), null, 2) : formatReport(result, meta));
    if (result.summary.not_checked === result.summary.routes) return 2;
    return result.summary.problems > 0 ? 1 : 0;
  } catch (error) {
    const known = error instanceof UserError || error instanceof JevError;
    write(stderr, `cache-boundary: ${known ? error.message : `unexpected error: ${error?.message ?? error}`}`);
    return 2;
  }
}
