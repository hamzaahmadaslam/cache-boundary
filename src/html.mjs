// Small HTML helpers without dependencies: tags and attributes, element contents, visible text and forms. They read
// HTML the way a quick scan needs (one linear pass, quoted attribute values respected); they are not a full parser.

// Named character references and the code points they stand for (numbers, so this file holds only ASCII).
const NAMED = Object.fromEntries(
  Object.entries({
    amp: 38,
    lt: 60,
    gt: 62,
    quot: 34,
    apos: 39,
    nbsp: 0xa0,
    copy: 0xa9,
    reg: 0xae,
    trade: 0x2122,
    hellip: 0x2026,
    ndash: 0x2013,
    mdash: 0x2014,
    lsquo: 0x2018,
    rsquo: 0x2019,
    ldquo: 0x201c,
    rdquo: 0x201d,
    laquo: 0xab,
    raquo: 0xbb,
    times: 0xd7,
    euro: 0x20ac,
    pound: 0xa3,
    yen: 0xa5,
    cent: 0xa2,
    middot: 0xb7,
    bull: 0x2022,
  }).map(([name, code]) => [name, String.fromCodePoint(code)]),
);

/** Decodes character references (&amp;, &#39;, &#x2F; and common named ones). Unknown names stay as they are. */
export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});?/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED[entity.toLowerCase()] ?? match;
  });
}

/** Lower-cases ASCII letters only, so indexes stay the same as in the original string. */
export function asciiLower(text) {
  return text.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

const isSpace = (code) => code === 32 || code === 9 || code === 10 || code === 13 || code === 12;

/** The index just after the `>` that closes the tag starting at `start`, or -1. Quotes after `=` are respected. */
function tagEnd(html, start) {
  let quote = 0;
  let afterEquals = false;
  for (let i = start + 1; i < html.length; i++) {
    const code = html.charCodeAt(i);
    if (quote) {
      if (code === quote) quote = 0;
      continue;
    }
    if (code === 62) return i + 1;
    if ((code === 34 || code === 39) && afterEquals) {
      quote = code;
      afterEquals = false;
    } else if (code === 61) afterEquals = true;
    else if (!isSpace(code)) afterEquals = false;
  }
  return -1;
}

const TAG_NAME = /[a-zA-Z][a-zA-Z0-9:-]*/y;

/** Every start or end tag: { name, closing, text, start, end }. `names` (a Set) limits it to those tag names. */
export function* tags(html, names = null) {
  let i = 0;
  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt < 0) return;
    let at = lt + 1;
    const closing = html.charCodeAt(at) === 47;
    if (closing) at++;
    TAG_NAME.lastIndex = at;
    const match = TAG_NAME.exec(html);
    if (!match) {
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt);
    if (end < 0) return;
    const name = match[0].toLowerCase();
    if (!names || names.has(name)) yield { name, closing, text: html.slice(lt, end), start: lt, end };
    i = end;
  }
}

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** The attributes of a start tag as { lowercase name: decoded value }. The first of repeated names wins. */
export function attributes(tagText) {
  const inner = tagText.replace(/^<\/?[^\s>/]+/, "").replace(/\/?>$/, "");
  const out = {};
  for (const m of inner.matchAll(ATTRIBUTE)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Every <name>...</name> element: { open, start, contentStart, contentEnd, end }. */
export function* elements(html, name, lower = asciiLower(html)) {
  const open = `<${name}`;
  const close = `</${name}`;
  let from = 0;
  for (;;) {
    const start = lower.indexOf(open, from);
    if (start < 0) return;
    const next = lower.charCodeAt(start + open.length);
    if (!(isSpace(next) || next === 62 || next === 47)) {
      from = start + 1;
      continue;
    }
    const contentStart = tagEnd(html, start);
    if (contentStart < 0) return;
    const openText = html.slice(start, contentStart);
    if (openText.endsWith("/>") && name !== "script") {
      yield { open: openText, start, contentStart, contentEnd: contentStart, end: contentStart };
      from = contentStart;
      continue;
    }
    let contentEnd = lower.indexOf(close, contentStart);
    let end;
    if (contentEnd < 0) {
      contentEnd = html.length;
      end = html.length;
    } else {
      const gt = lower.indexOf(">", contentEnd);
      end = gt < 0 ? html.length : gt + 1;
    }
    yield { open: openText, start, contentStart, contentEnd, end };
    from = end;
  }
}

/** Removes HTML comments. */
export function removeComments(html) {
  let out = "";
  let from = 0;
  for (;;) {
    const start = html.indexOf("<!--", from);
    if (start < 0) break;
    out += `${html.slice(from, start)} `;
    const end = html.indexOf("-->", start + 4);
    if (end < 0) return out;
    from = end + 3;
  }
  return out + html.slice(from);
}

/** Removes the named elements with everything inside them. */
export function removeElements(html, names) {
  let out = html;
  for (const name of names) {
    let result = "";
    let last = 0;
    for (const el of elements(out, name)) {
      result += out.slice(last, el.start);
      last = el.end;
    }
    out = result + out.slice(last);
  }
  return out;
}

/** Keeps the named elements' tags but empties them, so scanning tags never reads script or style code as HTML. */
export function blankElements(html, names) {
  let out = html;
  for (const name of names) {
    let result = "";
    let last = 0;
    for (const el of elements(out, name)) {
      result += out.slice(last, el.contentStart);
      last = el.contentEnd;
    }
    out = result + out.slice(last);
  }
  return out;
}

const BLOCK_TAGS = new Set(
  "address article aside blockquote br button dd div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr label li main nav ol option p pre section table tbody td tfoot th thead tr ul".split(
    " ",
  ),
);

/**
 * Removes the head. Its end tag is optional: without </head>, the head ends where <body> starts. Runs after scripts are
 * removed, so a "<head>" written inside a script is never taken for a head that runs to the end of the page.
 */
function removeHead(html) {
  const lower = asciiLower(html);
  let out = "";
  let last = 0;
  for (const el of elements(html, "head", lower)) {
    out += html.slice(last, el.start);
    last = el.end;
    if (el.contentEnd === html.length) {
      const body = lower.slice(el.contentStart).search(/<body[\s/>]/);
      if (body >= 0) last = el.contentStart + body;
    }
  }
  return out + html.slice(last);
}

/** The text a reader sees: no head, scripts, styles, templates, SVG or comments; one line per block element. */
export function visibleText(html) {
  const cleaned = removeHead(
    removeElements(removeComments(html), ["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas"]),
  ).replace(/<![^>]*>/g, " ");
  let out = "";
  let last = 0;
  for (const tag of tags(cleaned)) {
    out += cleaned.slice(last, tag.start);
    out += BLOCK_TAGS.has(tag.name) ? "\n" : " ";
    last = tag.end;
  }
  out += cleaned.slice(last);
  return decodeEntities(out)
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n\s*/g, "\n")
    .trim();
}

/** Collapses whitespace to single spaces. */
export function oneLine(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

const FIELD_TAGS = new Set(["input", "select", "textarea", "button"]);

/** The forms in a page: { id, name, className, action, method, fields: [{ tag, type, name, value }] }. */
export function forms(html) {
  const out = [];
  for (const el of elements(html, "form")) {
    const attrs = attributes(el.open);
    const fields = [];
    for (const tag of tags(html.slice(el.contentStart, el.contentEnd), FIELD_TAGS)) {
      if (tag.closing) continue;
      const a = attributes(tag.text);
      if (!a.name) continue;
      const type = (a.type ?? (tag.name === "input" ? "text" : tag.name)).toLowerCase();
      fields.push({ tag: tag.name, type, name: a.name, value: tag.name === "input" ? a.value ?? "" : "" });
    }
    out.push({
      id: attrs.id ?? "",
      name: attrs.name ?? "",
      className: attrs.class ?? "",
      action: attrs.action ?? "",
      method: (attrs.method || "get").toLowerCase(),
      fields,
    });
  }
  return out;
}

/** A short name for a form in reports and questions: `#id`, `form.class` or `form 2`. */
export function formLabel(form, index) {
  if (form.id) return `#${form.id}`;
  const first = form.className.split(/\s+/).find(Boolean);
  if (first) return `form.${first}`;
  if (form.name) return `form ${form.name}`;
  return `form ${index + 1}`;
}

/** The first <title>, as one line of text. */
export function titleOf(html) {
  for (const el of elements(html, "title")) return oneLine(decodeEntities(html.slice(el.contentStart, el.contentEnd)));
  return "";
}

/** The page's canonical URL (<link rel="canonical"> or og:url), or null. */
export function canonicalUrl(html) {
  let og = null;
  for (const tag of tags(html, new Set(["link", "meta"]))) {
    if (tag.closing) continue;
    const a = attributes(tag.text);
    if (tag.name === "link" && /(^|\s)canonical(\s|$)/i.test(a.rel ?? "") && a.href) return a.href;
    if (tag.name === "meta" && a.property === "og:url" && a.content && !og) og = a.content;
  }
  return og;
}

/** Replaces email addresses with a placeholder, so they are never sent. */
export function redactEmails(text) {
  return String(text).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email address]");
}
