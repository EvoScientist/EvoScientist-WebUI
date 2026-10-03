/**
 * LaTeX math support for the markdown pipeline beyond what remark-math parses
 * on its own.
 *
 * remark-math only understands `$…$` and `$$…$$`, but models routinely write
 * `\(…\)` and `\[…\]`. Markdown reads `\[` / `\(` as escaped punctuation, so
 * the formula used to render as raw TeX inside square brackets, and every `\\`
 * row break lost a backslash.
 *
 * `extractLatexMath` lifts each formula out of the source before markdown
 * parsing and leaves an opaque placeholder; `remarkLatexMath` swaps the
 * placeholders for math nodes after parsing. Rewriting to `$` syntax instead
 * lets the generated dollars pair with a stray `$5` in the text, and a
 * generated `$$` block would have to reproduce list indentation, lazy
 * continuation lines and table rows by hand.
 */

// Private-use characters: markdown leaves them alone and they never split a
// text node, so each placeholder reaches the syntax tree intact.
const PH_OPEN = "";
const PH_CLOSE = "";
const PLACEHOLDER = /(\d+)/g;

// Leading container syntax of a line: indentation, blockquote markers and list
// markers.
const CONTAINER_PREFIX =
  /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*[ \t]*/;
// Every repeat below must start on a distinct character: overlapping ones
// (`>[ \t]?` then `[ \t]*`) backtrack exponentially on a deep quote prefix.
const QUOTE_MARKERS = /^(?:[ \t]*>)*[ \t]*/;
const LIST_MARKERS = /^(?:[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t])*/;

// What a line starts with (after its quote markers) when it begins a block
// that can interrupt a paragraph — heading, fence, thematic break, setext
// underline, or one of CommonMark's HTML block kinds 1–6. The paragraph ends
// there, so a formula can't span it.
const BLOCK_START = new RegExp(
  "^(?:#{1,6}(?:[ \\t]|$)|`{3,}|~{3,}" +
    "|(?:(?:\\*[ \\t]*){3,}|(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|=+[ \\t]*)$" +
    "|<(?:script|pre|style|textarea)(?:[ \\t>]|$)|<!--|<\\?|<![A-Za-z]" +
    "|<!\\[CDATA\\[|</?(?:address|article|aside|base|basefont|blockquote" +
    "|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt" +
    "|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head" +
    "|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav" +
    "|noframes|ol|optgroup|option|p|param|search|section|summary|table" +
    "|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \\t]|/?>|$))",
  "i"
);
// A list item interrupts a paragraph too — but inside a display whose `\[`
// sits alone on its line, a leading `-` / `+` is an operator.
const LIST_ITEM_START = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;

// Inline HTML whose text markdown shows literally: no math inside. The HTML
// parser carries an unclosed `<code>` / `<tt>` on into later paragraphs, so
// those run to their closing tag; the others end with their paragraph.
// Known gaps, left as is: a nested `<code>` ends the literal run at the inner
// `</code>`; an open `<code>` doesn't carry past a fenced code block; and a
// formula whose closing delimiter sits inside a tag (`\(<code>x\)</code>`)
// still converts.
const LITERAL_TAG = /<(code|tt|kbd|samp|pre)\b[^>]{0,200}>/iy;
const CARRIED_TAGS = new Set(["code", "tt"]);

// Characters that only show up in a bracketed span when it is TeX. Keeps
// markdown's own escaped brackets (`\[1\]`, `\[link\](url)`) as brackets.
const MATH_SIGNAL = /[\\^_=+<>{}]/;
const BARE_INLINE_MATH = /^(?:[A-Za-z]|\d+(?:\.\d+)?)$/;

export interface LatexMath {
  tex: string;
  display: boolean;
  /** The formula as written, delimiters included. */
  raw: string;
}

interface Fence {
  char: string;
  size: number;
}

function containerPrefix(line: string): string {
  return CONTAINER_PREFIX.exec(line)?.[0] ?? "";
}

/**
 * A fence opener: indented at most three columns past its blockquote markers
 * (plus the one space a `>` may take), or anywhere inside a list item.
 * Indented further, it is a line of an indented code block.
 */
function fenceOpen(line: string): Fence | null {
  const quote = /^(?:[ \t]*>)*/.exec(line)![0];
  const list = LIST_MARKERS.exec(line.slice(quote.length))![0];
  const rest = line.slice(quote.length + list.length);
  const indent = /^[ \t]*/.exec(rest)![0];
  const columns = indent.replace(/\t/g, "    ").length;
  if (!list && columns > (quote ? 4 : 3)) return null;
  const m = /^(`{3,}|~{3,})(.*)$/.exec(rest.slice(indent.length));
  if (!m) return null;
  // A backtick in the info string makes it an inline code span, not a fence.
  if (m[1][0] === "`" && m[2].includes("`")) return null;
  return { char: m[1][0], size: m[1].length };
}

function closesFence(line: string, fence: Fence): boolean {
  const m = /^(`{3,}|~{3,})[ \t]*$/.exec(
    line.slice(containerPrefix(line).length)
  );
  return !!m && m[1][0] === fence.char && m[1].length >= fence.size;
}

/** True when the line starting right after the newline at `at` is blank. */
function blankLineAfter(src: string, at: number): boolean {
  let j = at + 1;
  while (src[j] === " " || src[j] === "\t") j++;
  return j >= src.length || src[j] === "\n";
}

function backtickRun(src: string, at: number): number {
  let j = at;
  while (src[j] === "`") j++;
  return j - at;
}

/** Index of the first entry of an ascending list that is >= `x`. */
function firstAtOrAfter(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function looksLikeMath(body: string, display: boolean): boolean {
  const text = body.trim();
  if (!text) return false;
  return MATH_SIGNAL.test(text) || (!display && BARE_INLINE_MATH.test(text));
}

const quoteDepth = (prefix: string) => (prefix.match(/>/g) ?? []).length;

function stripQuoteMarkers(line: string, depth: number): string {
  let rest = line;
  for (let d = 0; d < depth; d++) {
    const m = /^[ \t]*>[ \t]?/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  return rest;
}

/** Extract the formulas from markdown that contains no fenced code. */
function extractFromText(
  src: string,
  maths: LatexMath[],
  indexByRaw: Map<string, number>
): string {
  // One pass up front: paragraph breaks and backtick runs by length, so no
  // search below rescans the text.
  const blankLines: number[] = [];
  const runsBySize = new Map<number, number[]>();
  for (let j = 0; j < src.length; ) {
    if (src[j] === "`") {
      const run = backtickRun(src, j);
      const runs = runsBySize.get(run);
      if (runs) runs.push(j);
      else runsBySize.set(run, [j]);
      j += run;
      continue;
    }
    if (src[j] === "\n" && blankLineAfter(src, j)) blankLines.push(j);
    j++;
  }
  const paragraphEnd = (from: number) =>
    blankLines[firstAtOrAfter(blankLines, from)] ?? src.length;

  /** Start of the next run of exactly `size` backticks in the paragraph. */
  const findCodeSpanClose = (from: number, size: number): number => {
    const runs = runsBySize.get(size) ?? [];
    const close = runs[firstAtOrAfter(runs, from)];
    return close !== undefined && close < paragraphEnd(from) ? close : -1;
  };

  // The next closing tag per tag name. Searches only move forward, so each
  // tag's closers are found in one pass overall.
  const tagCloses = new Map<
    string,
    { from: number; at: number; end: number }
  >();
  const findTagClose = (tag: string, from: number): number => {
    let hit = tagCloses.get(tag);
    if (!hit || from < hit.from || (hit.at !== -1 && hit.at < from)) {
      const re = new RegExp(`</${tag}\\s*>`, "gi");
      re.lastIndex = from;
      const m = re.exec(src);
      hit = { from, at: m ? m.index : -1, end: m ? m.index + m[0].length : -1 };
      tagCloses.set(tag, hit);
    }
    if (CARRIED_TAGS.has(tag)) return hit.at === -1 ? src.length : hit.end;
    return hit.at !== -1 && hit.at < paragraphEnd(from) ? hit.end : -1;
  };

  // Where a failed search for each closer stopped. A later search starting
  // before that point walks the same escape pairs and fails the same way, so
  // it is skipped — otherwise every unclosed `\(` rescans the paragraph.
  const failedUntil = new Map<string, number>();

  /**
   * Whether the line starting at `start` begins a block a formula opened at
   * the given quote depth can't span.
   */
  const startsBlock = (
    start: number,
    openingDepth: () => number,
    ownLine: boolean
  ) => {
    const eol = src.indexOf("\n", start);
    const line = src.slice(start, eol === -1 ? src.length : eol);
    const quote = QUOTE_MARKERS.exec(line)![0];
    // More quote markers open a nested quote; as many or fewer continue.
    if (quoteDepth(quote) > openingDepth()) return true;
    const rest = line.slice(quote.length);
    return BLOCK_START.test(rest) || (!ownLine && LIST_ITEM_START.test(rest));
  };

  /** Index of the `\` of the closing `\]` / `\)` in the paragraph, or -1. */
  const findMathClose = (at: number, closer: string): number => {
    const from = at + 2;
    // The look back to the line start is lazy: on a long line holding many
    // formulas, doing it for each one would be quadratic.
    let prefix: string | undefined;
    const linePrefix = () =>
      (prefix ??= src.slice(src.lastIndexOf("\n", at - 1) + 1, at));
    // A `\[` with nothing else on its line. Rest of line first, so the look
    // back runs at most once per line.
    let j = from;
    while (src[j] === " " || src[j] === "\t") j++;
    const ownLine =
      closer === "]" &&
      (j >= src.length || src[j] === "\n") &&
      containerPrefix(linePrefix()) === linePrefix();
    // Separate records, since the two kinds stop at different lines.
    const key = ownLine ? "]own" : closer;
    if (from < (failedUntil.get(key) ?? -1)) return -1;
    let depth: number | undefined;
    const openingDepth = () =>
      (depth ??= quoteDepth(containerPrefix(linePrefix())));
    for (let j = from; j < src.length; j++) {
      if (src[j] === "\\") {
        if (src[j + 1] === closer) return j;
        j++; // `\\`, `\{`, `\sigma`: the escaped character can't close.
        continue;
      }
      if (
        src[j] === "\n" &&
        (blankLineAfter(src, j) || startsBlock(j + 1, openingDepth, ownLine))
      ) {
        failedUntil.set(key, j);
        return -1;
      }
    }
    failedUntil.set(key, src.length);
    return -1;
  };

  /** Placeholder for the formula opening at `at`, or null to keep it as is. */
  const extract = (at: number): { text: string; end: number } | null => {
    const display = src[at + 1] === "[";
    const close = findMathClose(at, display ? "]" : ")");
    if (close === -1) return null;
    const body = src.slice(at + 2, close);
    if (!looksLikeMath(body, display)) return null;

    const end = close + 2;
    const raw = src.slice(at, end);
    // The same formula gets the same placeholder, so a reference-link label
    // that holds one still matches its definition.
    let index = indexByRaw.get(raw);
    if (index === undefined) {
      let tex = body;
      if (body.includes("\n")) {
        // Continuation lines of a quoted formula carry the quote markers.
        const lineStart = src.lastIndexOf("\n", at - 1) + 1;
        const depth = quoteDepth(containerPrefix(src.slice(lineStart, at)));
        tex = body
          .split("\n")
          .map((line, k) => (k === 0 ? line : stripQuoteMarkers(line, depth)))
          .join("\n");
      }
      index = maths.push({ tex: tex.trim(), display, raw }) - 1;
      indexByRaw.set(raw, index);
    }
    return { text: `${PH_OPEN}${index}${PH_CLOSE}`, end };
  };

  let out = "";
  let i = 0;
  // Inside a URL (`https://…`, `www.…`), `\(` is part of the address. The
  // URL ends at whitespace, `>` (autolink) or a `)` it didn't open (link).
  let inUrl = false;
  let urlParens = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "`") {
      const run = backtickRun(src, i);
      const close = findCodeSpanClose(i + run, run);
      const end = close === -1 ? i + run : close + run;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "<") {
      LITERAL_TAG.lastIndex = i;
      const tag = LITERAL_TAG.exec(src);
      const end = tag
        ? findTagClose(tag[1].toLowerCase(), i + tag[0].length)
        : -1;
      if (end !== -1) {
        out += src.slice(i, end);
        i = end;
        continue;
      }
    }
    if (ch === "\\") {
      const next = src[i + 1];
      const found =
        !inUrl && (next === "[" || next === "(") ? extract(i) : null;
      if (found) {
        out += found.text;
        i = found.end;
        continue;
      }
      // Copy the escape pair whole so `\\[` is never read as `\[`.
      out += src.slice(i, i + 2);
      if (/\s/.test(next ?? "")) inUrl = false;
      i += 2;
      continue;
    }
    if (/\s/.test(ch) || ch === ">") inUrl = false;
    else if (inUrl && ch === "(") urlParens++;
    else if (inUrl && ch === ")") {
      if (urlParens > 0) urlParens--;
      else inUrl = false;
    } else if (
      !inUrl &&
      (src.startsWith("://", i) || src.startsWith("www.", i))
    ) {
      inUrl = true;
      urlParens = 0;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Replace each `\(…\)` / `\[…\]` formula with a placeholder for
 * `remarkLatexMath`. Code spans, fenced code, literal HTML (`<code>`, `<kbd>`…)
 * and URLs are left alone, as is an unclosed delimiter (still streaming), a
 * span that would cross into another block, or a bracketed span that doesn't
 * look like TeX.
 */
export function extractLatexMath(markdown: string): {
  markdown: string;
  maths: LatexMath[];
} {
  const maths: LatexMath[] = [];
  if (
    (!markdown.includes("\\[") && !markdown.includes("\\(")) ||
    markdown.includes(PH_OPEN) ||
    markdown.includes(PH_CLOSE)
  ) {
    return { markdown, maths };
  }

  const indexByRaw = new Map<string, number>();
  const out: string[] = [];
  let pending: string[] = [];
  let fence: Fence | null = null;
  const flush = () => {
    if (pending.length > 0)
      out.push(extractFromText(pending.join("\n"), maths, indexByRaw));
    pending = [];
  };

  // Markdown reads CR and CRLF as line endings too; with LF only, the
  // blank-line and fence checks hold for CRLF files.
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      out.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opened = fenceOpen(line);
    if (opened) {
      flush();
      out.push(line);
      fence = opened;
      continue;
    }
    pending.push(line);
  }
  flush();
  return { markdown: out.join("\n"), maths };
}

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  alt?: string | null;
  children?: MdastNode[];
  position?: { start: { offset?: number } };
  data?: unknown;
}

// The node and hast mapping remark-math builds for `$…$`.
function inlineMathNode(tex: string): MdastNode {
  return {
    type: "inlineMath",
    value: tex,
    data: {
      hName: "code",
      hProperties: { className: ["language-math", "math-inline"] },
      hChildren: [{ type: "text", value: tex }],
    },
  };
}

// The node and hast mapping remark-math builds for a `$$` fenced block.
function displayMathNode(tex: string): MdastNode {
  return {
    type: "math",
    value: tex,
    data: {
      hName: "pre",
      hChildren: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-math", "math-display"] },
          children: [{ type: "text", value: tex }],
        },
      ],
    },
  };
}

/** Text and formulas of a string with placeholders, in order. */
function pieces(value: string, maths: LatexMath[]): (string | LatexMath)[] {
  const out: (string | LatexMath)[] = [];
  let last = 0;
  for (const m of value.matchAll(PLACEHOLDER)) {
    if (m.index > last) out.push(value.slice(last, m.index));
    out.push(maths[Number(m[1])] ?? m[0]);
    last = m.index + m[0].length;
  }
  if (last < value.length) out.push(value.slice(last));
  return out;
}

const unescapeMarkdown = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, "$1");

/**
 * A placeholder that landed where math can't go (code the extractor didn't
 * recognise, a link URL, raw HTML) gets its original source back.
 */
function restoreSource(node: MdastNode, maths: LatexMath[]): void {
  const restore = (s: string, unescape: boolean) =>
    s.replace(PLACEHOLDER, (whole, i: string) => {
      const raw = maths[Number(i)]?.raw;
      if (raw === undefined) return whole;
      // Link URLs and titles had their escapes resolved by the parser.
      return unescape ? unescapeMarkdown(raw) : raw;
    });
  if (node.type !== "text" && typeof node.value === "string") {
    node.value = restore(node.value, false);
  }
  if (typeof node.url === "string") node.url = restore(node.url, true);
  if (typeof node.title === "string") node.title = restore(node.title, true);
  if (typeof node.alt === "string") node.alt = restore(node.alt, true);
}

function inlineNodes(text: MdastNode, maths: LatexMath[]): MdastNode[] {
  return pieces(text.value ?? "", maths).map((piece) =>
    typeof piece === "string"
      ? { type: "text", value: piece }
      : inlineMathNode(piece.tex)
  );
}

const isBlankText = (node: MdastNode) =>
  node.type === "text" && !node.value?.trim();

/**
 * A display formula on a line of its own splits its paragraph and becomes a
 * block; every other formula stays inline.
 */
function splitParagraph(paragraph: MdastNode, maths: LatexMath[]): MdastNode[] {
  const blocks: MdastNode[] = [];
  let current: MdastNode[] = [];
  let afterDisplay = false;

  const flush = () => {
    while (current.length > 0) {
      const last = current[current.length - 1];
      if (last.type === "break" || isBlankText(last)) current.pop();
      else break;
    }
    const last = current[current.length - 1];
    if (last?.type === "text") last.value = last.value?.trimEnd();
    if (current.length > 0) blocks.push({ ...paragraph, children: current });
    current = [];
  };
  const add = (node: MdastNode) => {
    if (afterDisplay) {
      if (node.type === "break") return;
      if (node.type === "text") {
        node.value = node.value?.trimStart();
        if (!node.value) return;
      }
      afterDisplay = false;
    }
    current.push(node);
  };
  const atLineStart = () => {
    const prev = current[current.length - 1];
    return (
      current.every(isBlankText) ||
      prev.type === "break" ||
      (prev.type === "text" && /\n[ \t]*$/.test(prev.value ?? ""))
    );
  };

  const children = paragraph.children ?? [];
  children.forEach((child, index) => {
    if (child.type !== "text") {
      transform(child, maths);
      add(child);
      return;
    }
    const parts = pieces(child.value ?? "", maths);
    parts.forEach((part, k) => {
      if (typeof part === "string") {
        add({ type: "text", value: part });
        return;
      }
      const next = parts[k + 1];
      const lineEndsInNode = typeof next === "string" && /^[ \t]*\n/.test(next);
      const nodeEnds =
        next === undefined ||
        (typeof next === "string" && !next.trim() && k + 2 === parts.length);
      const nextChild = children[index + 1];
      const endsLine =
        lineEndsInNode ||
        (nodeEnds && (nextChild === undefined || nextChild.type === "break"));
      if (part.display && atLineStart() && endsLine) {
        flush();
        blocks.push(displayMathNode(part.tex));
        afterDisplay = true;
      } else {
        add(inlineMathNode(part.tex));
      }
    });
  });
  flush();
  return blocks;
}

function transform(node: MdastNode, maths: LatexMath[]): void {
  restoreSource(node, maths);
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "paragraph") return splitParagraph(child, maths);
    if (child.type === "text") return inlineNodes(child, maths);
    transform(child, maths);
    return [child];
  });
}

/**
 * Remark plugin: turn the placeholders left by `extractLatexMath` into math
 * nodes. Pass the `maths` from the same extraction as the plugin option.
 */
export function remarkLatexMath(maths: LatexMath[] = []) {
  return (tree: MdastNode) => {
    if (maths.length > 0) transform(tree, maths);
  };
}

/**
 * The display nodes for a paragraph made only of `$$…$$` math, or null.
 * remark-math parses a one-line `$$x$$` as inline math, so a formula the
 * model set apart on its own line would render inline-sized.
 */
function displayMathOf(
  paragraph: MdastNode,
  source: string
): MdastNode[] | null {
  const blocks: MdastNode[] = [];
  for (const child of paragraph.children ?? []) {
    if (isBlankText(child)) continue;
    if (child.type !== "inlineMath") return null;
    const start = child.position?.start.offset;
    // Only `$$` was meant as display; a lone `$x$` stays inline.
    if (start === undefined || !source.startsWith("$$", start)) return null;
    blocks.push({
      ...displayMathNode(child.value ?? ""),
      position: child.position,
    });
  }
  return blocks.length > 0 ? blocks : null;
}

function promoteDisplayMath(node: MdastNode, source: string): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    const blocks =
      child.type === "paragraph" ? displayMathOf(child, source) : null;
    if (blocks) return blocks;
    promoteDisplayMath(child, source);
    return [child];
  });
}

/**
 * Remark plugin (after remark-math): a paragraph holding nothing but
 * `$$…$$` formulas renders as display math, one block per formula.
 */
export function remarkDisplayMath() {
  return (tree: MdastNode, file: { value?: unknown }) => {
    promoteDisplayMath(tree, String(file.value ?? ""));
  };
}
