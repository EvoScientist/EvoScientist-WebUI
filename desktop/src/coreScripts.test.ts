import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CORE_SCRIPTS_BASE,
  coreScriptsProblem,
  fetchCoreScripts,
  SOURCE_FILE,
} from "./coreScripts";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "core-scripts-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fetch that answers from a map of URL -> body; anything else is 404. */
const fakeFetch =
  (files: Record<string, string>): typeof fetch =>
  async (url) => {
    const body = files[String(url)];
    return new Response(body ?? "not found", { status: body ? 200 : 404 });
  };

const url = (name: string) => `${CORE_SCRIPTS_BASE}/v0.3.8/scripts/${name}`;

describe("fetchCoreScripts", () => {
  it("downloads both scripts from the version's tag and records where from", async () => {
    const outDir = join(tempDir(), "core-scripts");
    await fetchCoreScripts({
      version: "0.3.8",
      outDir,
      fetch: fakeFetch({
        [url("install.ps1")]: "# ps1",
        [url("install.sh")]: "#!/bin/sh",
      }),
    });
    expect(readFileSync(join(outDir, "install.ps1"), "utf8")).toBe("# ps1");
    expect(readFileSync(join(outDir, "install.sh"), "utf8")).toBe("#!/bin/sh");
    expect(JSON.parse(readFileSync(join(outDir, SOURCE_FILE), "utf8"))).toEqual(
      {
        version: "0.3.8",
        files: {
          "install.ps1": url("install.ps1"),
          "install.sh": url("install.sh"),
        },
      }
    );
    expect(coreScriptsProblem(outDir, "0.3.8")).toBeNull();
  });

  it("fails on a missing script and leaves nothing that passes the check", async () => {
    const outDir = join(tempDir(), "core-scripts");
    await expect(
      fetchCoreScripts({
        version: "0.3.8",
        outDir,
        fetch: fakeFetch({ [url("install.ps1")]: "# ps1" }),
      })
    ).rejects.toThrow(`${url("install.sh")}: HTTP 404`);
    expect(coreScriptsProblem(outDir, "0.3.8")).toMatch(/no source.json/);
  });
});

describe("coreScriptsProblem", () => {
  it("refuses scripts downloaded for another version", async () => {
    const outDir = join(tempDir(), "core-scripts");
    await fetchCoreScripts({
      version: "0.3.8",
      outDir,
      fetch: fakeFetch({
        [url("install.ps1")]: "a",
        [url("install.sh")]: "b",
      }),
    });
    expect(coreScriptsProblem(outDir, "0.3.9")).toMatch(
      /are for 0.3.8, the app installs 0.3.9/
    );
    rmSync(join(outDir, "install.sh"));
    expect(coreScriptsProblem(outDir, "0.3.8")).toMatch(/missing .*install.sh/);
  });
});
