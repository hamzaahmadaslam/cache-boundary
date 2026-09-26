// Reads what the user asked to check: URLs on the command line or in a --urls file, and saved responses. A saved
// response is an .html file with its headers in a .headers file next to it (curl -D cart.headers -o cart.html URL),
// or an .html file that starts with the headers (curl -i URL > cart.html).
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { UserError } from "./errors.mjs";
import { cookieNames, decodeBody, MAX_BYTES, normalizeHost } from "./fetch.mjs";
import { canonicalUrl } from "./html.mjs";

const PAGE_FILE = /\.html?$/i;
const STATUS_LINE = /^HTTP\/[\d.]+\s+(\d{3})\b/i;

const short = (text) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);
const toPosix = (p) => p.split(path.sep).join("/");

/** The text without a byte order mark at the start. */
const withoutBom = (text) => (String(text).charCodeAt(0) === 0xfeff ? String(text).slice(1) : String(text));

function readProblem(target, error) {
  if (error?.code === "ENOENT") return `Cannot read ${target}: there is no such file or folder.`;
  if (error?.code === "EACCES" || error?.code === "EPERM") return `Cannot read ${target}: permission denied.`;
  return `Cannot read ${target}: ${error?.message ?? error}`;
}

/** Every .html and .htm file below a folder, skipping node_modules and folders that start with a dot. */
function walk(folder) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && PAGE_FILE.test(entry.name)) found.push(full);
    }
  };
  visit(folder);
  return found;
}

/**
 * Sorts the arguments into URLs and saved-response files, and adds the URLs from a --urls file.
 * Returns { urls: [href], files: [{ path, label }] }. Throws a UserError for anything it cannot use.
 */
export function collectInputs(positionals, urlsFile) {
  const urls = [];
  const files = [];
  const addUrl = (text, where) => {
    let url;
    try {
      url = new URL(text);
    } catch {
      throw new UserError(`${where}: "${short(text)}" is not a valid URL.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new UserError(`${where}: only http and https URLs can be checked, not ${url.protocol}`);
    }
    if (url.username || url.password) {
      throw new UserError(`${where}: remove the user name and password from the URL for ${url.host}; the tool does not send credentials.`);
    }
    url.hash = "";
    if (!urls.includes(url.href)) urls.push(url.href);
  };
  for (const arg of positionals) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
      addUrl(arg, "URL");
      continue;
    }
    let stat;
    try {
      stat = statSync(arg);
    } catch (error) {
      throw new UserError(readProblem(arg, error));
    }
    if (stat.isDirectory()) {
      const found = walk(arg);
      if (!found.length) throw new UserError(`${arg} holds no .html or .htm files.`);
      for (const file of found) files.push({ path: file, label: toPosix(path.relative(arg, file)) });
    } else if (PAGE_FILE.test(arg)) {
      files.push({ path: arg, label: toPosix(arg) });
    } else if (/\.txt$/i.test(arg)) {
      throw new UserError(`${arg}: to read URLs from a file, use --urls ${arg}.`);
    } else {
      throw new UserError(`${arg}: give URLs, saved .html files (with a .headers file next to each) or a folder of them.`);
    }
  }
  if (urlsFile !== undefined) {
    let text;
    try {
      text = readFileSync(urlsFile, "utf8");
    } catch (error) {
      throw new UserError(readProblem(urlsFile, error));
    }
    text.split(/\r?\n/).forEach((line, i) => {
      const value = line.trim();
      if (value && !value.startsWith("#")) addUrl(value, `${urlsFile} line ${i + 1}`);
    });
  }
  const seen = new Set();
  const unique = files.filter((file) => {
    const key = path.resolve(file.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { urls, files: unique };
}

/** The hosts of the URLs, in the form redirects are compared against. */
export function hostsOf(urls) {
  return new Set(urls.map((href) => normalizeHost(new URL(href).hostname)));
}

/**
 * Parses response headers saved as text (curl -D, curl -i, or name: value lines copied from a browser). With several
 * blocks (redirects), the last final response wins; Set-Cookie names are collected from every block.
 * Returns { status, headers, setCookieNames } or null for an empty file.
 */
export function parseHeaderText(text) {
  const blocks = [];
  let current = null;
  for (const raw of withoutBom(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      if (current) blocks.push(current);
      current = null;
      continue;
    }
    const status = STATUS_LINE.exec(line);
    if (status) {
      if (current) blocks.push(current);
      current = { status: Number(status[1]), lines: [] };
      continue;
    }
    if (!current) current = { status: null, lines: [] };
    if (/^[ \t]/.test(raw) && current.lines.length) current.lines[current.lines.length - 1] += ` ${line.trim()}`;
    else current.lines.push(line);
  }
  if (current) blocks.push(current);
  if (!blocks.length) return null;
  const final = [...blocks].reverse().find((b) => b.status === null || b.status >= 200) ?? blocks[blocks.length - 1];
  const headers = {};
  const setCookieNames = [];
  for (const block of blocks) {
    for (const line of block.lines) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === "set-cookie") setCookieNames.push(...cookieNames([value]));
      else if (block === final) headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
    }
  }
  return { status: final.status, headers, setCookieNames };
}

/** Splits `curl -i` output into its header blocks and the body, or returns null when the text has no headers. */
export function splitInlineHeaders(text) {
  let rest = withoutBom(text);
  if (!STATUS_LINE.test(rest)) return null;
  let headerText = "";
  while (STATUS_LINE.test(rest)) {
    const gap = /\r?\n\r?\n/.exec(rest);
    if (!gap) {
      headerText += rest;
      rest = "";
      break;
    }
    headerText += `${rest.slice(0, gap.index)}\n\n`;
    rest = rest.slice(gap.index + gap[0].length);
  }
  return { headers: parseHeaderText(headerText), body: rest };
}

function readCapped(file, maxBytes = MAX_BYTES) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    return size > maxBytes ? { buffer: buffer.subarray(0, maxBytes), truncated: true } : { buffer: buffer.subarray(0, size), truncated: false };
  } finally {
    closeSync(fd);
  }
}

/** The path (with query) of a URL, or null. */
export function pathOf(href) {
  try {
    const url = new URL(href);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** Loads one saved response as a route. Its URL, when known, comes from the page's canonical link or og:url. */
export function readSaved(file) {
  const base = { kind: "saved", input: file.label, label: file.label, redirects: [], second: null };
  let capped;
  try {
    capped = readCapped(file.path);
  } catch (error) {
    return { ...base, error: readProblem(file.label, error) };
  }
  const text = decodeBody(capped.buffer, null);
  let saved = null;
  let body = text;
  const inline = splitInlineHeaders(text);
  if (inline) {
    saved = inline.headers;
    body = inline.body;
  } else {
    const sibling = file.path.replace(PAGE_FILE, ".headers");
    if (existsSync(sibling)) {
      try {
        saved = parseHeaderText(readFileSync(sibling, "utf8"));
      } catch (error) {
        return { ...base, error: readProblem(toPosix(sibling), error) };
      }
    }
  }
  const url = canonicalUrl(body);
  return {
    ...base,
    url,
    path: url ? pathOf(url) : null,
    status: saved?.status ?? null,
    headers: saved?.headers ?? {},
    hasHeaders: Boolean(saved),
    setCookieNames: saved?.setCookieNames ?? [],
    body,
    truncated: capped.truncated,
  };
}
