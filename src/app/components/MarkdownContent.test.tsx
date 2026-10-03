import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "./MarkdownContent";

const render = (content: string) =>
  renderToStaticMarkup(<MarkdownContent content={content} />);

const count = (html: string, needle: string) => html.split(needle).length - 1;
const displayCount = (html: string) => count(html, 'class="katex-display"');
const katexCount = (html: string) => count(html, 'class="katex"');

describe("MarkdownContent math", () => {
  it("renders \\[ … \\] as display math instead of literal brackets", () => {
    const html = render(
      "先用：\n\n\\[ \\sigma_{\\rm rep}=\\max(f,1)\\sqrt{\\sigma_{\\rm formal}^{2}+\\sigma_{\\rm sys}^{2}} \\]\n\n对实际参数：\n\n\\[ \\boxed{\\sigma_{\\rm final}=\\sqrt{\\sigma_{\\rm rep}^{2}+u_{\\rm offset}^{2}}} \\]"
    );
    expect(displayCount(html)).toBe(2);
    expect(html).not.toContain("[ \\sigma");
  });

  it("renders \\( … \\) as inline math", () => {
    const html = render("设 \\(f\\ge 1\\) 为系数");
    expect(katexCount(html)).toBe(1);
    expect(displayCount(html)).toBe(0);
  });

  it("keeps matrix row breaks inside \\[ … \\]", () => {
    const html = render("\\[ \\begin{pmatrix}1&2\\\\3&4\\end{pmatrix} \\]");
    expect(displayCount(html)).toBe(1);
    expect(html).not.toContain("katex-error");
    // Both rows survive: the annotation keeps the original TeX source.
    expect(html).toContain("1&amp;2\\\\3&amp;4");
  });

  it("renders a display inside a list item within that item", () => {
    const html = render("1. 误差：\n\n   \\[ x^2 \\]\n\n2. 下一步");
    expect(displayCount(html)).toBe(1);
    expect(count(html, "<li>")).toBe(2);
  });

  it("renders a one-line $$ … $$ paragraph as display math", () => {
    const html = render("text\n\n$$\\sigma_{\\rm rep}$$\n\nmore");
    expect(displayCount(html)).toBe(1);
  });

  it("renders consecutive one-line $$ … $$ lines as separate displays", () => {
    const html = render("$$a^2$$\n$$b^2$$");
    expect(displayCount(html)).toBe(2);
  });

  it("keeps $$ … $$ in the middle of a sentence inline", () => {
    const html = render("where $$a=b$$ holds");
    expect(katexCount(html)).toBe(1);
    expect(displayCount(html)).toBe(0);
  });

  it("keeps a lone single-dollar formula inline", () => {
    const html = render("$x^2$");
    expect(katexCount(html)).toBe(1);
    expect(displayCount(html)).toBe(0);
  });

  it("leaves LaTeX inside code untouched", () => {
    const html = render("```latex\n\\[x^2\\]\n```");
    expect(katexCount(html)).toBe(0);
    expect(html).toContain("\\[x^2\\]");
  });

  it("leaves LaTeX inside an indented code block untouched", () => {
    const html = render("para\n\n    \\(x^2\\) and \\[y^2\\]\n");
    expect(katexCount(html)).toBe(0);
    expect(html).toContain("\\(x^2\\) and \\[y^2\\]");
  });

  it("splits a paragraph around a display on its own line", () => {
    const html = render("先用：\n\\[ x^2 \\]\n对");
    expect(displayCount(html)).toBe(1);
    expect(html).toContain("<p>先用：</p>");
    expect(html).toContain("<p>对</p>");
  });

  it("keeps the rest of a lazily continued list item after a display", () => {
    const html = render(
      "- item\n  \\[ a +\nb \\]\n**bold** [link](https://example.com)\n\nafter"
    );
    expect(displayCount(html)).toBe(1);
    const item = /<li>[\s\S]*?<\/li>/.exec(html)?.[0] ?? "";
    expect(item).toContain("katex-display");
    expect(item).toContain("<strong>bold</strong>");
    expect(html).toContain("<p>after</p>");
  });

  it("renders a display inside a blockquote", () => {
    const html = render("> 引用：\n> \\[ a^2 +\n> b^2 \\]\n\nafter");
    const quote = /<blockquote[\s\S]*?<\/blockquote>/.exec(html)?.[0] ?? "";
    expect(quote).toContain("katex-display");
    // The quote marker of the continuation line is not part of the formula.
    expect(html).not.toContain("&gt; b^2");
    expect(html).toContain("<p>after</p>");
  });

  it("renders a mid-sentence display inline", () => {
    const html = render("where \\[x^2\\] holds");
    expect(katexCount(html)).toBe(1);
    expect(displayCount(html)).toBe(0);
  });

  it("keeps a display inline when text follows it on the same line", () => {
    const html = render("\\[ x^2 \\] 其中 x 为输入");
    expect(katexCount(html)).toBe(1);
    expect(displayCount(html)).toBe(0);
    expect(html).toContain("其中 x 为输入");
  });

  it("keeps a display inline when text precedes it on the same line", () => {
    const html = render("结果为 \\[ x^2 \\]\n下一行");
    expect(katexCount(html)).toBe(1);
    expect(displayCount(html)).toBe(0);
  });

  it("renders adjacent formulas separately", () => {
    const html = render("设 \\(a\\)\\(b^2\\) 结束，\\[c^2\\]\\[d^2\\] 也是");
    expect(katexCount(html)).toBe(4);
    expect(html).not.toContain("$");
  });

  it("does not pair a converted formula with a currency dollar", () => {
    const html = render("costs $5, where \\(x\\) is the input");
    expect(katexCount(html)).toBe(1);
    expect(html).toContain("costs $5, where ");
  });

  it("keeps a table row that starts with a formula inside the table", () => {
    const html = render("a | b\n--|--\n\\[x^2\\] | 2\n3 | 4");
    expect(count(html, "<tr>")).toBe(3);
    expect(katexCount(html)).toBe(1);
  });

  it("renders a formula inside a heading", () => {
    const html = render("## \\(x^2\\) 的意义");
    expect(/<h2>[\s\S]*class="katex"[\s\S]*<\/h2>/.test(html)).toBe(true);
  });

  it("restores a formula-like span inside a link URL", () => {
    const html = render("[a](/docs/\\(x\\))");
    expect(html).toContain('href="/docs/(x)"');
    expect(katexCount(html)).toBe(0);
  });

  it("leaves a formula-like span inside a bare URL alone", () => {
    const html = render("https://example.com/\\(x^2\\)");
    expect(html).toContain('href="https://example.com/%5C(x%5E2%5C)"');
    expect(html).toContain(">https://example.com/\\(x^2\\)</a>");
    expect(katexCount(html)).toBe(0);
  });

  it("keeps a reference link whose label holds a formula", () => {
    const html = render("[foo \\(x^2\\)]: /path\n\n[foo \\(x^2\\)]");
    expect(html).toContain('href="/path"');
    expect(katexCount(html)).toBe(1);
  });

  it("leaves a formula inside inline HTML code literal", () => {
    const html = render("<code>\\(x^2\\)</code> 和 <kbd>\\[y^2\\]</kbd>");
    expect(katexCount(html)).toBe(0);
    expect(html).toContain("(x^2)");
    expect(html).toContain("[y^2]");
  });

  it("does not pair delimiters across a heading", () => {
    const html = render("Intro \\[a^2\n# Heading \\]");
    expect(katexCount(html)).toBe(0);
    expect(html).toContain("<h1>Heading ]</h1>");
  });

  it("does not pair delimiters across a list item", () => {
    const html = render("Intro \\(a^2\n- item \\)");
    expect(katexCount(html)).toBe(0);
    expect(html).toContain("<li>item )</li>");
  });

  it("does not pair delimiters into a blockquote", () => {
    const html = render("Intro \\(a^2\n> quote \\)");
    expect(katexCount(html)).toBe(0);
    expect(html).toContain("<blockquote");
  });

  it("does not pair delimiters into a nested blockquote", () => {
    const html = render("> Intro \\[a^2\n>> nested \\]");
    expect(katexCount(html)).toBe(0);
    expect(count(html, "<blockquote")).toBe(2);
  });

  it("keeps text inside an open <code> literal across paragraphs", () => {
    for (const input of [
      "<code>foo\n\n\\(x^2\\)</code>",
      "<code>foo\n\n后面 \\(x^2\\) 段落",
      '<code\nclass="x">\\(x^2\\)</code>',
    ]) {
      const html = render(input);
      expect(katexCount(html)).toBe(0);
      expect(html).toContain("(x^2)");
    }
  });

  it("renders a formula right after a link", () => {
    const html = render("[site](https://example.com)\\(x^2\\)");
    expect(html).toContain('href="https://example.com"');
    expect(katexCount(html)).toBe(1);
  });

  it("renders a display with operator lines between its own-line delimiters", () => {
    const html = render("\\[\na^2\n- b^2\n\\]");
    expect(displayCount(html)).toBe(1);
    expect(html).not.toContain("<li>");
  });

  it("renders a formula after a code line indented four spaces", () => {
    const html = render("    ```\n\n\\[x^2\\]");
    expect(displayCount(html)).toBe(1);
  });

  it("restores a formula-like span inside image alt text", () => {
    expect(render("![\\(x^2\\)](a.png)")).toContain('alt="(x^2)"');
  });

  it("restores a formula inside a raw HTML block", () => {
    const html = render("<div>\\(x^2\\)</div>");
    expect(html).toContain("<div>\\(x^2\\)</div>");
    expect(katexCount(html)).toBe(0);
  });

  it("keeps an escaped bracket citation as text", () => {
    expect(render("见 \\[1\\]。")).toContain("见 [1]。");
  });
});
