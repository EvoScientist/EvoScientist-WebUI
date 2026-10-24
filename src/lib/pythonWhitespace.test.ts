import { describe, expect, it } from "vitest";
import { PY_SPACE, pySplit, pyStrip } from "./pythonWhitespace";

// The characters Python's str.isspace() takes (CPython 3.11, checked against
// re's \s and str.split()).
const PYTHON = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];

describe("PY_SPACE", () => {
  it("takes exactly Python's whitespace", () => {
    const taken: number[] = [];
    for (let c = 0; c <= 0x10ffff; c++) {
      if (PY_SPACE.test(String.fromCodePoint(c))) taken.push(c);
    }
    expect(taken).toEqual(PYTHON);
  });
});

describe("pyStrip", () => {
  it("strips what Python strips", () => {
    expect(pyStrip("\u0085 x y\u001f\n")).toBe("x y");
    expect(pyStrip("\ufeffx")).toBe("\ufeffx");
    expect(pyStrip(" \t ")).toBe("");
  });

  it("stays quick on a long run of spaces inside the text", () => {
    // Quadratic, this would take seconds; linear, well under a millisecond.
    const text = `x${" ".repeat(20_000)}y`;
    const started = performance.now();
    for (let i = 0; i < 10; i++) expect(pyStrip(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

// Expected values are Python's own str.split() results.
describe("pySplit", () => {
  it.each([
    ["", -1, []],
    ["   ", -1, []],
    ["a b", -1, ["a", "b"]],
    ["  a \t\n b  ", -1, ["a", "b"]],
    ["a\x1cb\x85c", -1, ["a", "b", "c"]],
    ["a\ufeffb", -1, ["a\ufeffb"]],
    ["amend  tighten it ", 1, ["amend", "tighten it "]],
    ["  amend", 1, ["amend"]],
    ["amend ", 1, ["amend"]],
    ["a b c", 0, ["a b c"]],
    [" a b c", 0, ["a b c"]],
  ] as const)("%j with maxsplit %d", (text, maxsplit, words) => {
    expect(pySplit(text, maxsplit)).toEqual(words);
  });
});
