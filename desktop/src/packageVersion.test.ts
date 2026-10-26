import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const version = (file: string) =>
  (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;

describe("the app's version", () => {
  // main.ts checks the core's `webui_compat` against app.getVersion(), which
  // is desktop/package.json's; the bundled WebUI carries the root's.
  it("is the bundled WebUI's", () => {
    expect(version(join(__dirname, "..", "package.json"))).toBe(
      version(join(__dirname, "..", "..", "package.json"))
    );
  });
});
