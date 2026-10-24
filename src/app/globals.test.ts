// The theme tokens the components name. jsdom never loads globals.css, so a
// class naming a token that isn't defined passes every render test and draws
// nothing: bg-[var(--brand-soft)] did that on every pill and badge. Each
// --brand token a component names is defined in both themes.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CSS = readFileSync(join(HERE, "globals.css"), "utf8");

/** The --brand tokens the first rule for `selector` declares in `css`,
 *  comments left out (a commented-out declaration defines nothing). */
function declaredBrandTokens(css: string, selector: string): Set<string> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = text.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const open = text.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0)
      return new Set(
        [
          ...text
            .slice(open + 1, i)
            .matchAll(/(?:^|[\s;{])(--brand[a-z-]*)\s*:/g),
        ].map((m) => m[1])
      );
  }
  throw new Error(`no rule for ${selector}`);
}

/** Every source file under `dir` but the tests. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

describe("globals.css", () => {
  it("defines every --brand token the components use, in both themes", () => {
    const used = new Set(
      sources(join(HERE, "..")).flatMap((file) =>
        [
          ...readFileSync(file, "utf8").matchAll(/var\((--brand[a-z-]*)\)/g),
        ].map((m) => m[1])
      )
    );
    expect([...used]).toContain("--brand");
    for (const [theme, selector] of [
      ["light", ":root"],
      ["dark", ".dark"],
    ] as const) {
      const declared = declaredBrandTokens(CSS, selector);
      expect({
        theme,
        missing: [...used].filter((token) => !declared.has(token)),
      }).toEqual({ theme, missing: [] });
    }
  });

  // A renamed selector must fail the check, not fall back to the first
  // brace in the file (`@layer base {`, which holds both themes).
  it("throws when the rule isn't there", () => {
    const css = "@layer base { :root { --brand: #000; } }";
    expect(() => declaredBrandTokens(css, ".dark")).toThrow(/no rule/);
  });

  it("doesn't count a declaration left in a comment", () => {
    const css = ":root { --brand: #000; /* --brand-soft: #fff; */ }";
    expect([...declaredBrandTokens(css, ":root")]).toEqual(["--brand"]);
  });
});
