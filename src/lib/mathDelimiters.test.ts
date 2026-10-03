import { describe, expect, it } from "vitest";
import { extractLatexMath } from "./mathDelimiters";

/** The extracted markdown with each placeholder spelled out as ⟦D|I:tex⟧. */
function show(markdown: string): string {
  const { markdown: out, maths } = extractLatexMath(markdown);
  return out.replace(/\uE000(\d+)\uE001/g, (_, i: string) => {
    const m = maths[Number(i)];
    return `⟦${m.display ? "D" : "I"}:${m.tex}⟧`;
  });
}

describe("extractLatexMath — display \\[ … \\]", () => {
  it("replaces a display with a placeholder", () => {
    expect(show("先用：\n\n\\[ \\sigma = 1 \\]\n\n对")).toBe(
      "先用：\n\n⟦D:\\sigma = 1⟧\n\n对"
    );
  });

  it("replaces a multi-line display, trimming the ends", () => {
    expect(show("\\[\n\\boxed{a^2}\n\\]")).toBe("⟦D:\\boxed{a^2}⟧");
  });

  it("keeps the line breaks inside a formula", () => {
    expect(show("\\[ a = b \\\\\n c = d \\]")).toBe("⟦D:a = b \\\\\n c = d⟧");
  });

  it("drops the blockquote markers of continuation lines from the formula", () => {
    expect(show("> 引用\n> \\[\n> a = b\n> \\]")).toBe("> 引用\n> ⟦D:a = b⟧");
  });

  it("keeps double backslashes inside the formula intact", () => {
    expect(show("\\[ \\begin{pmatrix}1&2\\\\3&4\\end{pmatrix} \\]")).toBe(
      "⟦D:\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}⟧"
    );
  });

  it("does not treat \\\\[ inside a formula as a closing delimiter", () => {
    expect(show("\\[ a \\\\[4pt] b \\]")).toBe("⟦D:a \\\\[4pt] b⟧");
  });

  it("marks a mid-sentence display as display too", () => {
    expect(show("where \\[x^2\\] holds")).toBe("where ⟦D:x^2⟧ holds");
  });

  it("replaces every display in the message", () => {
    expect(show("\\[ a^2 \\]\n\n\\[ b^2 \\]")).toBe("⟦D:a^2⟧\n\n⟦D:b^2⟧");
  });

  it("records the original source of each formula", () => {
    expect(extractLatexMath("a \\[ x^2 \\] b").maths).toEqual([
      { tex: "x^2", display: true, raw: "\\[ x^2 \\]" },
    ]);
  });

  it("gives the same formula the same placeholder", () => {
    // Reference-link labels only match if their text matches.
    const { markdown, maths } = extractLatexMath("\\(x\\) and \\(x\\)");
    expect(maths).toHaveLength(1);
    expect(markdown).toBe("\uE0000\uE001 and \uE0000\uE001");
  });
});

describe("extractLatexMath — inline \\( … \\)", () => {
  it("replaces \\( … \\) with a placeholder", () => {
    expect(show("设 \\(f\\ge 1\\) 为系数")).toBe("设 ⟦I:f\\ge 1⟧ 为系数");
  });

  it("converts a single-letter variable", () => {
    expect(show("where \\(x\\) is the input")).toBe("where ⟦I:x⟧ is the input");
  });

  it("converts a plain number", () => {
    expect(show("取 \\(0.5\\)")).toBe("取 ⟦I:0.5⟧");
  });

  it("keeps an inline formula that wraps onto the next line", () => {
    expect(show("设 \\(a +\nb\\) 为和")).toBe("设 ⟦I:a +\nb⟧ 为和");
  });

  it("converts a formula with an escaped dollar sign", () => {
    expect(show("price \\(\\$5 + x\\)")).toBe("price ⟦I:\\$5 + x⟧");
  });

  it("converts adjacent formulas separately", () => {
    expect(show("\\(a\\)\\(b^2\\)")).toBe("⟦I:a⟧⟦I:b^2⟧");
  });
});

describe("extractLatexMath — leaves non-math alone", () => {
  const unchanged = (s: string) => {
    const r = extractLatexMath(s);
    expect(r.markdown).toBe(s);
    expect(r.maths).toEqual([]);
  };

  it("keeps escaped brackets that hold plain text", () => {
    unchanged("see \\[1\\] and \\[link\\](https://example.com)");
  });

  it("keeps escaped parentheses around ordinary words", () => {
    unchanged("matches \\( and \\) literally");
  });

  it("does not touch inline code", () => {
    unchanged("type `\\[x^2\\]` or ``a \\(x^2\\) b``");
  });

  it("does not touch fenced code blocks", () => {
    unchanged("```latex\n\\[x^2\\]\n```\n\n~~~\n\\(y^2\\)\n~~~");
  });

  it("does not touch a fenced block nested in a list item", () => {
    unchanged("- code:\n\n  ```\n  \\[x^2\\]\n  ```");
  });

  it("does not touch a fenced block in a quote, `>` plus four spaces in", () => {
    unchanged(">    ~~~\n> \\(x^2\\)\n>    ~~~");
  });

  it("converts again once a fenced block closes", () => {
    expect(show("```\n\\[a^2\\]\n```\n\\[ b^2 \\]")).toBe(
      "```\n\\[a^2\\]\n```\n⟦D:b^2⟧"
    );
  });

  it("does not treat an escaped backslash before [ as an opening delimiter", () => {
    // Markdown reads `\\[` as a literal backslash plus `[`, even with a
    // matching `\]` later on.
    unchanged("a \\\\[x^2\\] b and \\\\(c^2\\)");
  });

  it("leaves an unclosed display alone while it is still streaming", () => {
    unchanged("先用：\n\n\\[ \\sigma_{\\rm rep}=");
  });

  it("does not pair delimiters across a line that starts a block", () => {
    for (const line of [
      "# Heading",
      "- item",
      "1. item",
      "> quote",
      "```",
      "---",
      "<div>",
    ]) {
      unchanged(`a \\(b^2\n${line}\nc \\)`);
    }
  });

  it("converts formulas again after a URL ends", () => {
    expect(show("see https://example.com/a and \\(x^2\\)")).toBe(
      "see https://example.com/a and ⟦I:x^2⟧"
    );
  });

  it("does not let a code span or <kbd> reach past its paragraph", () => {
    expect(show("`a\n\n\\(x^2\\) `")).toBe("`a\n\n⟦I:x^2⟧ `");
    expect(show("<kbd>a\n\n\\(x^2\\) </kbd>")).toBe("<kbd>a\n\n⟦I:x^2⟧ </kbd>");
  });

  it("keeps <code> literal up to its closing tag, across paragraphs", () => {
    // The HTML parser carries an open <code> into the following paragraphs.
    unchanged("<code>a\n\n\\(x^2\\) </code>");
    expect(show("<code>a\n\n\\(x^2\\)</code> \\(y^2\\)")).toBe(
      "<code>a\n\n\\(x^2\\)</code> ⟦I:y^2⟧"
    );
    unchanged("<code>a\n\n后面 \\(x^2\\) 段落");
    unchanged('<code\nclass="x">\\(x^2\\)</code>');
  });

  it("converts a formula right after a link or an autolink", () => {
    expect(show("[site](https://example.com)\\(x^2\\)")).toBe(
      "[site](https://example.com)⟦I:x^2⟧"
    );
    expect(show("<https://example.com>\\(x^2\\)")).toBe(
      "<https://example.com>⟦I:x^2⟧"
    );
  });

  it("keeps balanced parentheses inside a URL", () => {
    unchanged("https://en.wikipedia.org/wiki/A_(b)\\(x^2\\)");
  });

  it("does not pair delimiters into a deeper blockquote", () => {
    unchanged("> a \\(b^2\n>> c \\)");
  });

  it("lets a display that opens on its own line span operator lines", () => {
    expect(show("\\[\na^2\n- b^2\n+ c\n\\]")).toBe("⟦D:a^2\n- b^2\n+ c⟧");
  });

  it("converts an own-line display after an unclosed one in its paragraph", () => {
    expect(show("x \\[ y^2\n\\[\na^2\n- b\n\\]")).toBe(
      "x \\[ y^2\n⟦D:a^2\n- b⟧"
    );
  });

  it("still stops a display that follows text on its line at a list item", () => {
    unchanged("a \\[\nb^2\n- item\nc \\]");
  });

  it("still stops a display that shares its opening line at a list item", () => {
    unchanged("a \\[b^2\n- item\nc \\]");
  });

  it("does not take an inequality line for an HTML block", () => {
    expect(show("\\(a\n<x^2\\)")).toBe("⟦I:a\n<x^2⟧");
  });

  it("pairs delimiters across a quoted continuation line", () => {
    expect(show("> a \\(b +\n> c\\)")).toBe("> a ⟦I:b +\nc⟧");
  });

  it("does not pair delimiters across a blank line", () => {
    unchanged("\\[ a^2\n\nb^2 \\]");
  });

  it("does not pair delimiters across a CRLF blank line", () => {
    expect(extractLatexMath("\\[ a^2\r\n\r\nb^2 \\] \\(c^2\\)").maths).toEqual([
      { tex: "c^2", display: false, raw: "\\(c^2\\)" },
    ]);
  });

  it("does not touch a fenced block with CRLF line endings", () => {
    expect(show("```\r\n\\[a^2\\]\r\n```\r\n\\[ b^2 \\]")).toBe(
      "```\n\\[a^2\\]\n```\n⟦D:b^2⟧"
    );
  });

  it("returns text without delimiters unchanged", () => {
    unchanged("already $x^2$ and\n\n$$\ny^2\n$$");
  });

  it("leaves text that already holds a placeholder character alone", () => {
    unchanged("odd \uE000 char \\(x^2\\)");
  });
});

describe("extractLatexMath — scales linearly", () => {
  // A quadratic scan took seconds on inputs like these (up to 730 KB).
  const inputs: Record<string, string> = {
    "unclosed \\(": "\\( ".repeat(40000),
    "unclosed \\[": "\\[ ".repeat(40000),
    // Same-size runs pair up, so only distinct run lengths stay unmatched.
    "unmatched backtick runs": Array.from(
      { length: 1200 },
      (_, k) => "`".repeat(k + 1) + " \\(x\\) "
    ).join(""),
    "unclosed <code> tags": "<code> \\(x\\) ".repeat(40000),
    // A regex with ambiguous nested repeats backtracked exponentially here.
    "a deeply nested quote prefix": "> ".repeat(26) + "\\[",
    "many formulas on one line": "\\(x\\) ".repeat(20000),
  };
  for (const [name, input] of Object.entries(inputs)) {
    it(`handles ${name} quickly`, () => {
      const t0 = performance.now();
      extractLatexMath(input);
      expect(performance.now() - t0).toBeLessThan(250);
    });
  }
});
