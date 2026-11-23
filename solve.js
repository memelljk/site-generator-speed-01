// Fast drop-in reimplementation of makefun-site 1.0.0's build(input).
// Same output, byte for byte; optimised internals:
//  - HTML escaping scans a plain run once instead of one regex replace per character
//  - slugify has an ASCII fast path (NFKD is the identity there) and a per-build cache
//  - Markdown lexing and rendering are fused: no token objects, lines classified by first char
//  - cards, link records and long dates are computed once per source and reused
// No state survives a run() call: every cache below is created inside build().

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped; returns the input untouched when there is nothing to escape. */
function escapeHtml(s) {
  let out = '';
  let last = 0;
  let m;
  ESC_RE.lastIndex = 0;
  while ((m = ESC_RE.exec(s)) !== null) {
    if (m.index > last) out += s.slice(last, m.index);
    out += ESC[m[0]];
    last = m.index + 1;
  }
  if (last === 0) return s;
  return last < s.length ? out + s.slice(last) : out;
}

const SLUG_MAX = 64;
let slugCache = null; // per-build Map, set by build()

function slugifyRaw(text) {
  // ASCII fast path: NFKD is the identity on ASCII and no combining marks occur.
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      let keep = -1;
      if (code >= 65 && code <= 90) keep = code + 32;
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  if (out.endsWith('-')) out = out.replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugify(text) {
  let v = slugCache.get(text);
  if (v === undefined) { v = slugifyRaw(text); slugCache.set(text, v); }
  return v;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let dateCache = null; // per-build Map

function longDate(date) {
  let v = dateCache.get(date);
  if (v === undefined) {
    const y = date.slice(0, 4), m = date.slice(5, 7), d = date.slice(8, 10);
    v = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    dateCache.set(date, v);
  }
  return v;
}

const WORD_RUN = /\S+/g;

/** The count of runs of non-whitespace characters in `text`. */
function wordsCount(text) {
  let n = 0;
  WORD_RUN.lastIndex = 0;
  while (WORD_RUN.exec(text) !== null) n++;
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  // Line scan by offsets (the body is never split): line 0 must be "---", the next line that is exactly "---"
  // closes the front matter, and the body is everything after that line.
  const firstNl = text.indexOf('\n');
  if ((firstNl === -1 ? text : text.slice(0, firstNl)) !== '---') return { error: 'no front matter' };
  const fmLines = [];
  let closeEnd = -1; // index just past the closing line's "\n" (or text.length)
  if (firstNl !== -1) {
    let pos = firstNl + 1;
    let lineNo = 1; // 1-based line number of the line at pos, counting the opening --- as line 1
    while (pos <= text.length) {
      const nl = text.indexOf('\n', pos);
      const end = nl === -1 ? text.length : nl;
      const line = text.slice(pos, end);
      lineNo++;
      if (line === '---') { closeEnd = nl === -1 ? text.length : nl + 1; break; }
      fmLines.push({ line, lineNo });
      if (nl === -1) break;
      pos = nl + 1;
    }
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (const { line, lineNo } of fmLines) {
    let blank = true;
    for (let k = 0; k < line.length; k++) { const c = line[k]; if (c !== ' ' && c !== '\t') { blank = false; break; } }
    if (blank || line[0] === '#') continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${lineNo} is not "key: value"` };
    const key = m[1];
    const raw0 = m[2] ?? '';
    let raw = raw0;
    if (raw.endsWith(' ') || raw.endsWith('\t')) raw = raw.replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const CONTINUED = /^ {2,}\S/;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line[i]; if (c !== ' ' && c !== '\t') return false; }
  return true;
}

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's {depth, text}, or null. Mirrors /^(#{1,6})[ \t]+(.*?)[ \t]*$/. */
function headingOf(line) {
  if (line[0] !== '#') return null;
  let depth = 0;
  while (depth < line.length && line[depth] === '#') depth++;
  if (depth > 6) return null;
  if (depth === line.length || (line[depth] !== ' ' && line[depth] !== '\t')) return null;
  let k = depth;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  let end = line.length;
  while (end > k && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (end === k) return null;
  return { depth, text: line.slice(k, end) };
}

function isHR(line) {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (end !== 3) return false;
  const a = line[0];
  return (a === '-' || a === '*') && line[1] === a && line[2] === a;
}

function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  return FENCE_OPEN.exec(line);
}

function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** Bullet marker length (2) when `line` opens a bullet item, else 0. */
function bulletAt(line) {
  return (line[0] === '-' || line[0] === '*') && line[1] === ' ' ? 2 : 0;
}

/** {start, len} when `line` opens an ordered item (/^(\d{1,9})\. (.*)$/), else null. */
function orderedAt(line) {
  let d = 0;
  while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
  if (d === 0 || d > 9) return null;
  if (line[d] !== '.' || line[d + 1] !== ' ') return null;
  return { num: Number(line.slice(0, d)), len: d + 2 };
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

const INLINE_TRIG = /[\\`*\[]/g;

function inline(s, env) {
  let out = '';
  let start = 0; // start of the current plain run
  let i = 0;
  const flush = (end) => { if (end > start) out += escapeHtml(s.slice(start, end)); };
  while (i < s.length) {
    INLINE_TRIG.lastIndex = i;
    const trig = INLINE_TRIG.exec(s);
    if (trig === null) break;
    i = trig.index;
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      flush(i);
      const n = s[i + 1];
      out += ESC[n] ?? n;
      i += 2; start = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1; start = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2; start = i;
        } else {
          flush(i);
          out += '**';
          i += 2; start = i;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1; start = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1; start = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(s.length);
  return out;
}

function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const fence = fenceOpen(line);
    if (fence !== null) {
      let body = '';
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) { body += escapeHtml(lines[i]) + '\n'; i++; }
      i++;
      const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
      blocks.push(`<pre><code${cls}>${body}</code></pre>\n`);
      continue;
    }
    const heading = line[0] === '#' ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { blocks.push('<hr>\n'); i++; continue; }
    if (line[0] === '>') {
      const parts = [];
      while (i < lines.length && lines[i][0] === '>') {
        const raw = lines[i++];
        const stripped = raw[1] === ' ' ? raw.slice(2) : raw.slice(1);
        const t = trimLine(stripped);
        if (t !== '') parts.push(t);
      }
      blocks.push(parts.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(parts.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bAt = bulletAt(line);
    const oAt = bAt === 0 ? orderedAt(line) : null;
    if (bAt !== 0 || oAt !== null) {
      const isOrdered = oAt !== null;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedAt(l);
          if (m !== null) { items.push([trimLine(l.slice(m.len))]); i++; }
          else if (CONTINUED.test(l)) { items[items.length - 1].push(trimLine(l)); i++; }
          else break;
        } else {
          const b = bulletAt(l);
          if (b !== 0) { items.push([trimLine(l.slice(b))]); i++; }
          else if (CONTINUED.test(l)) { items[items.length - 1].push(trimLine(l)); i++; }
          else break;
        }
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && oAt.num !== 1 ? `<ol start="${oAt.num}">` : `<${tag}>`;
      let block = `${open}\n`;
      for (const parts of items) block += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${block}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderInto(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.kind) {
      case 'text': out.push(n.text); break;
      case 'var': out.push(escapeHtml(textOf(lookup(scope, n.path)))); break;
      case 'raw': out.push(textOf(lookup(scope, n.path))); break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderInto(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderInto(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInto(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

export function run(input) { return build(input); }

export function build(input) {
  slugCache = new Map();
  dateCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. sources in code-unit order; .md is a source, anything else static
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter and the refusal checks, in order
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  sources = kept;

  // 3. permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. markdown, links resolved (hrefs cached per directory+target within this build)
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        const key = dir + '\n' + target;
        const hit = linkCache.get(key);
        if (hit !== undefined) {
          if (hit.broken) broken.add(`broken-link ${s.path} -> ${target}`);
          return hit.href;
        }
        let href, isBroken = false;
        if (schemeRe.test(target) || target.startsWith('/') || target.startsWith('#')) href = target;
        else {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
          else { href = target; isBroken = true; }
        }
        linkCache.set(key, { href, broken: isBroken });
        if (isBroken) broken.add(`broken-link ${s.path} -> ${target}`);
        return href;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. layouts (cards and link records computed once per source)
  const cardOf = (s) => {
    if (s.card === undefined) {
      s.card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsCount(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
    }
    return s.card;
  };
  const linkOf = (s) => {
    if (s === null) return null;
    if (s.linkRec === undefined) s.linkRec = { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
    return s.linkRec;
  };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderInto(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of sources) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
