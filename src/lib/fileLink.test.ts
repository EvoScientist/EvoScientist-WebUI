// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  detectFileLink,
  dispatchFileLink,
  FILE_LINK_EVENT,
  FILE_LINK_HREF_PREFIX,
  rehypePathLinks,
} from "./fileLink";

describe("detectFileLink", () => {
  it("returns null for empty or whitespace strings", () => {
    expect(detectFileLink("")).toBeNull();
    expect(detectFileLink("   ")).toBeNull();
  });

  it("rejects strings containing internal whitespace", () => {
    expect(detectFileLink("/a b.md")).toBeNull();
    expect(detectFileLink("outputs/ foo.md")).toBeNull();
  });

  it("rejects scheme URLs (http, https, mailto, file)", () => {
    expect(detectFileLink("http://example.com/a.md")).toBeNull();
    expect(detectFileLink("HTTPS://example.com/a.md")).toBeNull();
    expect(detectFileLink("mailto:x@y.com")).toBeNull();
    expect(detectFileLink("file:///tmp/x.md")).toBeNull();
  });

  it("rejects strings without a slash", () => {
    expect(detectFileLink("field_name.md")).toBeNull();
    expect(detectFileLink("foo.md")).toBeNull();
  });

  it("rejects strings without a known extension", () => {
    expect(detectFileLink("/dir/foo.bak")).toBeNull();
    expect(detectFileLink("outputs/notes")).toBeNull();
  });

  it("rejects strings where the last dot precedes the last slash", () => {
    // `outputs.v2/file` has a `.` in the directory but no extension.
    expect(detectFileLink("outputs.v2/file")).toBeNull();
  });

  it("treats extension check as case-insensitive", () => {
    const link = detectFileLink("outputs/FIGURE.PNG");
    expect(link).not.toBeNull();
    expect(link?.kind).toBe("workspace");
  });

  it("classifies /memories/... as a memory link and strips the prefix from path", () => {
    expect(detectFileLink("/memories/notes/day1.md")).toEqual({
      kind: "memory",
      display: "/memories/notes/day1.md",
      path: "notes/day1.md",
    });
  });

  it("collapses repeated leading slashes on /memories/", () => {
    expect(detectFileLink("/memories///a.md")).toEqual({
      kind: "memory",
      display: "/memories///a.md",
      path: "a.md",
    });
  });

  it("strips a leading slash from workspace paths", () => {
    expect(detectFileLink("/final_report.md")).toEqual({
      kind: "workspace",
      display: "/final_report.md",
      path: "final_report.md",
    });
  });

  it("strips a leading ./ from workspace paths", () => {
    expect(detectFileLink("./attention.pdf")).toEqual({
      kind: "workspace",
      display: "./attention.pdf",
      path: "attention.pdf",
    });
  });

  it("accepts a bare relative workspace path (dir/file.ext)", () => {
    expect(detectFileLink("outputs/figure.png")).toEqual({
      kind: "workspace",
      display: "outputs/figure.png",
      path: "outputs/figure.png",
    });
  });

  it("trims surrounding whitespace before classifying", () => {
    expect(detectFileLink("  /notes.md  ")?.path).toBe("notes.md");
  });
});

describe("dispatchFileLink", () => {
  it("emits a CustomEvent with the FileLink as detail", () => {
    const listener = vi.fn();
    window.addEventListener(FILE_LINK_EVENT, listener as EventListener);
    const link = {
      kind: "workspace" as const,
      display: "/a.md",
      path: "a.md",
    };
    dispatchFileLink(link);
    expect(listener).toHaveBeenCalledTimes(1);
    const ev = listener.mock.calls[0][0] as CustomEvent;
    expect(ev.type).toBe(FILE_LINK_EVENT);
    expect(ev.detail).toEqual(link);
    window.removeEventListener(FILE_LINK_EVENT, listener as EventListener);
  });

  it("carries the control the link was opened from", () => {
    const listener = vi.fn();
    window.addEventListener(FILE_LINK_EVENT, listener as EventListener);
    const opener = document.createElement("button");
    dispatchFileLink(
      { kind: "workspace", display: "a.md", path: "a.md" },
      opener
    );
    const ev = listener.mock.calls[0][0] as CustomEvent;
    expect(ev.detail.opener).toBe(opener);
    window.removeEventListener(FILE_LINK_EVENT, listener as EventListener);
  });
});

describe("rehypePathLinks", () => {
  const wrap = (text: string) => ({
    type: "root",
    children: [{ type: "text", value: text }],
  });

  it("replaces a bare-text path with an <a> node encoded via FILE_LINK_HREF_PREFIX", () => {
    const tree = wrap("See /outputs/report.md for details.");
    rehypePathLinks()(tree);
    expect(tree.children).toHaveLength(3);
    const [pre, link, post] = tree.children as any[];
    expect(pre).toEqual({ type: "text", value: "See " });
    expect(link.tagName).toBe("a");
    expect(link.properties.href).toBe(
      `${FILE_LINK_HREF_PREFIX}${encodeURIComponent("/outputs/report.md")}`
    );
    expect(link.children[0].value).toBe("/outputs/report.md");
    expect(post).toEqual({ type: "text", value: " for details." });
  });

  it("leaves text with no path match untouched", () => {
    const tree = wrap("no path here");
    const before = JSON.parse(JSON.stringify(tree));
    rehypePathLinks()(tree);
    expect(tree).toEqual(before);
  });

  it("does not descend into <code>/<pre>/<a> children", () => {
    const codeChild = {
      type: "element" as const,
      tagName: "code",
      children: [{ type: "text", value: "/outputs/report.md" }],
    };
    const tree = { type: "root", children: [codeChild] };
    rehypePathLinks()(tree);
    // The <code> block should be untouched — no <a> injection inside it.
    expect(codeChild.children).toHaveLength(1);
    expect((codeChild.children[0] as any).type).toBe("text");
  });

  it("descends into regular elements (e.g. <p>) and rewrites bare-text paths inside", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element" as const,
          tagName: "p",
          children: [{ type: "text", value: "at outputs/figure.png here" }],
        },
      ],
    };
    rehypePathLinks()(tree);
    const p = tree.children[0] as any;
    const linkChild = p.children.find(
      (c: any) => c.type === "element" && c.tagName === "a"
    );
    expect(linkChild).toBeDefined();
    expect(linkChild.properties.href).toBe(
      `${FILE_LINK_HREF_PREFIX}${encodeURIComponent("outputs/figure.png")}`
    );
  });

  it("handles multiple matches in one text node", () => {
    const tree = wrap("open /a.md and outputs/b.png please");
    rehypePathLinks()(tree);
    const links = (tree.children as any[]).filter(
      (c) => c.type === "element" && c.tagName === "a"
    );
    expect(links).toHaveLength(2);
    expect(links[0].children[0].value).toBe("/a.md");
    expect(links[1].children[0].value).toBe("outputs/b.png");
  });
});
