// Formats results for people (the report, the dry run) and for programs (JSON). Every word printed comes from the
// input (URLs, file names, header values, class names) or from the fixed text in this file; Jev returns only
// probabilities. Token and cookie values are never printed.
import { estimatePlan } from "./check.mjs";
import { BLOCK_ORDER, shortReason } from "./decide.mjs";
import { tokenShape } from "./tokens.mjs";

const VERDICT_TITLES = {
  "do-not-cache": "Do not cache",
  vary: "Cache one copy per cookie value",
  cache: "Cache: one stored copy for every visitor",
  review: "Review: check these yourself",
  "not-checked": "Not checked",
};
const ORDER = ["do-not-cache", "vary", "cache", "review", "not-checked"];
const RULE_NAMES = { cache: "cache", cache_with_vary_on_cookie: "vary on cookie", do_not_cache: "do not cache" };

const REASONS = {
  visitor_content: "Jev: shows content for one visitor",
  private_token: "Jev: holds a token that must not be shared",
  rule_do_not_cache: "Jev: the rule for this page is do not cache",
  rule_vary: "Jev: the page changes with a cookie",
  unsure_visitor: "unclear whether it shows one visitor's content",
  unsure_token: "unclear whether it holds a private token",
  unsure_rule: "unclear which cache rule fits",
  answers_disagree: "the answers disagree",
  no_headers: "no response headers, so Set-Cookie, Cache-Control and Vary are unknown (save them with curl -D)",
  truncated: "larger than 2 MB, and only the first 2 MB was read",
  not_html: "not an HTML page",
  too_large: "too large to send in one request",
  no_answer: "no answer from TypeSafe",
};
const NOTES = new Set(["cache_hit", "second_failed", "set_cookie_other", "saved_personal"]);
const MAX_LINES = 6;

const count = (n) => n.toLocaleString("en-US");
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;
const p2 = (value) => value.toFixed(2);

/** What was checked: "5 URLs on example.com, fetched twice each; 4 saved responses". */
function scope(routes, twice) {
  const fetched = routes.filter((r) => r.kind === "fetched");
  const saved = routes.length - fetched.length;
  const parts = [];
  if (fetched.length) {
    const hosts = [...new Set(fetched.map((r) => new URL(r.input).host))];
    const shown = hosts.length > 3 ? `${hosts.slice(0, 3).join(", ")} and ${plural(hosts.length - 3, "other host")}` : hosts.join(", ");
    parts.push(`${plural(fetched.length, "URL")} on ${shown}${twice ? ", fetched twice each" : ""}`);
  }
  if (saved) parts.push(plural(saved, "saved response"));
  return `${plural(routes.length, "route")} (${parts.join("; ")})`;
}

/** How a route is named: the URL, or the file name with the path from its canonical link. */
export function routeName(route) {
  if (route.kind === "fetched") return route.url && route.url !== route.input ? `${route.input} (redirected to ${route.url})` : route.input;
  return route.path ? `${route.label} (${route.path})` : route.label;
}

function ruleAnswer(rule) {
  const ranked = Object.entries(rule.probabilities)
    .filter(([, value]) => typeof value === "number")
    .sort((a, b) => b[1] - a[1]);
  const shown = ranked.filter(([, value], i) => i === 0 || value >= 0.05).slice(0, 3);
  return `${shown.map(([name, value]) => `${RULE_NAMES[name] ?? name} ${p2(value)}`).join(", ")} (confidence ${p2(rule.confidence)})`;
}

function jevLine(answer) {
  return `Jev: visitor content ${p2(answer.visitor)} | private token ${p2(answer.token)} | rule: ${ruleAnswer(answer.rule)}`;
}

function limited(lines) {
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `and ${lines.length - MAX_LINES + 1} more`] : lines;
}

function formatRoute(result) {
  const { analysis, verdict, decidedBy, reasons, answer } = result;
  const route = analysis.route;
  const pad = "      ";
  const heading = `  ${routeName(route)}${decidedBy === "code" && verdict === "do-not-cache" ? "  decided in code, nothing sent" : ""}`;
  if (verdict === "not-checked") return [heading, `${pad}${analysis.reason}`];
  const lines = [heading];
  const of = (level) => analysis.signals.filter((s) => s.level === level);
  if (decidedBy === "code" && verdict === "do-not-cache") {
    const rank = (s) => (BLOCK_ORDER.includes(s.id) ? BLOCK_ORDER.indexOf(s.id) : BLOCK_ORDER.length);
    const block = of("block").sort((a, b) => rank(a) - rank(b));
    for (const line of limited(block.map((s) => s.text))) lines.push(`${pad}${line}`);
  } else {
    const why = reasons.map((r) => REASONS[r] ?? r);
    if (why.length) lines.push(`${pad}${why.join("; ")}`);
    for (const signal of of("vary")) lines.push(`${pad}${signal.text}`);
    if (answer) lines.push(`${pad}${jevLine(answer)}`);
    if (verdict === "cache" || verdict === "vary") {
      lines.push(`${pad}headers: ${analysis.checks.headers}`);
      lines.push(`${pad}page: ${analysis.checks.page}`);
      if (analysis.checks.twice) lines.push(`${pad}twice: ${analysis.checks.twice}`);
    }
    for (const signal of of("caution")) lines.push(`${pad}caution: ${signal.text}`);
  }
  for (const signal of analysis.signals.filter((s) => NOTES.has(s.id))) lines.push(`${pad}note: ${signal.text}`);
  return lines;
}

function table(rows, indent = "    ") {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}   ${right}`.trimEnd());
}

function formatRules(rules) {
  const lines = [];
  if (rules.paths.length) {
    lines.push("  Do not cache these paths:");
    lines.push(
      ...table(
        rules.paths.map((p) => [p.path ? `${p.path}${p.below ? " and everything below it" : ""}` : `(no URL known for ${p.label})`, p.reason]),
      ),
    );
  }
  if (rules.bypass.length) {
    lines.push("  Skip the cache for requests with these cookies:");
    lines.push(...table(rules.bypass.map((b) => [b.cookie, b.reason])));
  }
  if (rules.vary.length) {
    lines.push("  Keep one stored copy per value of:");
    lines.push(...table(rules.vary.map((v) => [v.cookie, `${v.reason}, on ${v.paths.join(", ")}`])));
  }
  return lines;
}

/** The human-readable report: counts, problems, the routes by verdict, and the suggested rules. */
export function formatReport(result, meta) {
  const { summary, usage, threshold } = result;
  const routes = result.results.map((r) => r.analysis.route);
  const decided = summary.decided_in_code ? `; ${plural(summary.decided_in_code, "route")} decided in code` : "";
  const lines = [
    `cache-boundary: ${scope(routes, meta.twice)}`,
    usage.requests
      ? `Model ${result.model}, ${plural(usage.requests, "request")}, ${count(usage.input_tokens)} input tokens, threshold ${threshold}${decided}`
      : `No requests to TypeSafe, threshold ${threshold}${decided}`,
    "",
    [
      `do not cache ${summary.do_not_cache}`,
      `vary ${summary.vary}`,
      `cache ${summary.cache}`,
      `review ${summary.review}`,
      ...(summary.not_checked ? [`not checked ${summary.not_checked}`] : []),
    ].join("   "),
  ];
  const problems = result.results.filter((r) => r.problems.length);
  if (problems.length) {
    lines.push("", "Problems (exit code 1)");
    for (const r of problems) {
      lines.push(`  ${routeName(r.analysis.route)}`);
      for (const p of r.problems) lines.push(`      ${p.text}`);
    }
  }
  for (const verdict of ORDER) {
    const group = result.results.filter((r) => r.verdict === verdict);
    if (!group.length) continue;
    lines.push("", VERDICT_TITLES[verdict]);
    for (const r of group) lines.push(...formatRoute(r));
  }
  const rules = formatRules(result.rules);
  lines.push("", "Suggested rules (from the confident verdicts; check them against your cache's own settings)");
  lines.push(...(rules.length ? rules : ["  No rules to suggest."]));
  lines.push("", `Verdicts come from checks in code first, then from Jev's answers at or above the threshold (${threshold}).`);
  if (summary.review) lines.push("Routes in review had answers below the threshold, answers that disagreed, or missing evidence.");
  return `${lines.join("\n")}\n`;
}

function routeJson(result) {
  const { analysis, verdict, decidedBy, reasons, answer, problems } = result;
  const route = analysis.route;
  return {
    input: route.input,
    kind: route.kind,
    url: route.url ?? null,
    path: route.path ?? null,
    status: route.status ?? null,
    verdict,
    decided_by: decidedBy,
    reasons,
    reason_text: reasons.map((r) => REASONS[r] ?? r),
    ...(analysis.status === "checked"
      ? {
          signals: analysis.signals.map(({ id, level, text }) => ({ id, level, text })),
          checks: analysis.checks,
          tokens: analysis.tokens.map((t) => ({
            name: t.name,
            where: t.where,
            kind: t.label,
            shape: tokenShape(t.values[0]),
            comparison: analysis.compared ? t.comparison : null,
          })),
          served_from_cache: analysis.servedFromCache,
        }
      : { not_checked: analysis.reason }),
    answers: answer
      ? {
          visitor_content: answer.visitor,
          private_token: answer.token,
          cache_rule: answer.rule,
        }
      : null,
    redirects: route.redirects ?? [],
    problems,
  };
}

/** The report as JSON: every route, its verdict, the signals, the raw probabilities, and the rules. */
export function toJson(result, meta) {
  return {
    tool: "cache-boundary",
    version: meta.version,
    threshold: result.threshold,
    model: result.model,
    twice: meta.twice,
    summary: result.summary,
    usage: result.usage,
    routes: result.results.map(routeJson),
    rules: result.rules,
  };
}

function planLine(entry) {
  const { analysis } = entry;
  const route = analysis.route;
  if (analysis.status !== "checked") return [routeName(route), `not checked: ${analysis.reason}`];
  const block = analysis.signals.filter((s) => s.level === "block");
  if (block.length) return [routeName(route), `decided in code: do not cache (${shortReason({ analysis, decidedBy: "code", reasons: [] })})`];
  if (!entry.request) return [routeName(route), analysis.tooLarge ? "review: too large to send" : "review: not an HTML page"];
  const vary = analysis.signals.filter((s) => s.level === "vary").map((s) => s.text);
  return [routeName(route), `1 request, about ${count(entry.request.tokens)} tokens${vary.length ? `; vary: ${vary.join("; ")}` : ""}`];
}

/** What --dry-run prints: each route's plan, the token estimate, and the three questions for one route. */
export function formatDryRun(plan, meta) {
  const estimate = estimatePlan(plan);
  const routes = plan.entries.map((e) => e.analysis.route);
  const fetched = routes.some((route) => route.kind === "fetched");
  const lines = [
    `Dry run: nothing was sent to TypeSafe.${fetched ? " The URLs were fetched, as a visitor without cookies, to build the requests." : ""}`,
    "",
    `cache-boundary: ${scope(routes, meta.twice)}`,
    ...table(plan.entries.map(planLine), "  "),
    "",
    `${plural(plan.requests.length, "request")} to ${meta.model}, about ${count(estimate.tokens)} input tokens`,
  ];
  const example = plan.requests[0];
  if (example) {
    lines.push("", `Each request asks three questions about one route. For ${routeName(example.analysis.route)}:`);
    for (const [id, question] of Object.entries(example.request.body.questions)) {
      const options = question.type === "choice" ? `: ${Object.keys(question.criteria).join(", ")}` : "";
      lines.push(`  ${id} (${question.type}${options})`, `    ${question.instructions}`);
    }
  }
  lines.push("", "Run with --dry-run --json to see every request body.");
  return `${lines.join("\n")}\n`;
}

/** What --dry-run --json prints: the estimate and every request body exactly as it would be sent. */
export function dryRunJson(plan, meta) {
  const estimate = estimatePlan(plan);
  return {
    tool: "cache-boundary",
    version: meta.version,
    dry_run: true,
    model: meta.model,
    twice: meta.twice,
    summary: {
      routes: plan.entries.length,
      requests: plan.requests.length,
      decided_in_code: plan.entries.filter((e) => e.analysis.status === "checked" && e.analysis.signals.some((s) => s.level === "block")).length,
      not_checked: plan.entries.filter((e) => e.analysis.status !== "checked").length,
    },
    estimated_input_tokens: estimate.tokens,
    routes: plan.entries.map((entry) => ({
      input: entry.analysis.route.input,
      path: entry.analysis.route.path ?? null,
      plan: planLine(entry)[1],
      signals: entry.analysis.status === "checked" ? entry.analysis.signals.map(({ id, level, text }) => ({ id, level, text })) : [],
    })),
    requests: plan.requests.map((entry) => ({
      route: entry.analysis.route.input,
      estimated_tokens: entry.request.tokens,
      body: entry.request.body,
    })),
  };
}
