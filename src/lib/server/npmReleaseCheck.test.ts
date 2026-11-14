import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  main,
  npmState,
  packedProblem,
  parseArgs,
  readPackedFile,
  releaseAction,
  releaseTags,
} from "../../../scripts/npm-release-check.mjs";

// The release workflow's npm jobs run scripts/npm-release-check.mjs before
// they pack and before they publish (.github/workflows/desktop.yml).

const answer = (status: number, body?: unknown) =>
  vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
      })
  );

describe("releaseAction", () => {
  const npm = { versions: ["0.5.2", "0.5.3"], latest: "0.5.3" };
  const tags = ["v0.5.2", "v0.5.3", "v0.5.4"];

  it("publishes a version npm doesn't have yet", () => {
    expect(releaseAction("v0.5.4", "0.5.4", npm, tags)).toBe("publish");
    // The package's first version.
    expect(releaseAction("v0.1.0", "0.1.0", null, ["v0.1.0"])).toBe("publish");
  });

  // A run re-tried after a publish by hand passes without publishing again.
  it("skips a version npm has already", () => {
    expect(releaseAction("v0.5.3", "0.5.3", npm, tags)).toBe("skip");
  });

  it("refuses a tag that doesn't name package.json's version", () => {
    expect(() => releaseAction("v0.5.4", "0.5.3", npm, tags)).toThrow(
      /v0\.5\.4.*0\.5\.3/
    );
    expect(() => releaseAction("0.5.4", "0.5.4", npm, tags)).toThrow(
      /is not v0\.5\.4/
    );
  });

  // `npm publish` moves `latest`, which `npx @evoscientist/webui@latest`
  // installs.
  it("refuses a pre-release", () => {
    expect(() =>
      releaseAction("v0.6.0-rc.1", "0.6.0-rc.1", npm, [...tags, "v0.6.0-rc.1"])
    ).toThrow(/pre-release/);
  });

  // The repository's tags are read at once; npm's metadata can be minutes
  // old, so a newer version published a moment ago may not show there yet.
  it("refuses a version below a newer release tag", () => {
    expect(() =>
      releaseAction("v0.5.4", "0.5.4", npm, [...tags, "v0.5.5"])
    ).toThrow(/v0\.5\.5 is newer/);
    // A newer pre-release tag doesn't count: it never becomes latest.
    expect(
      releaseAction("v0.5.4", "0.5.4", npm, [...tags, "v0.6.0-rc.1"])
    ).toBe("publish");
  });

  it("refuses a version below npm's latest", () => {
    expect(() =>
      releaseAction(
        "v0.5.1",
        "0.5.1",
        { versions: ["0.5.3"], latest: "0.5.3" },
        ["v0.5.1"]
      )
    ).toThrow(/below npm's latest 0\.5\.3/);
  });

  it("compares versions as numbers, a pre-release below its release", () => {
    expect(
      releaseAction(
        "v0.10.0",
        "0.10.0",
        { versions: ["0.9.9"], latest: "0.9.9" },
        ["v0.9.9", "v0.10.0"]
      )
    ).toBe("publish");
    expect(() =>
      releaseAction("v0.9.10", "0.9.10", { versions: [], latest: null }, [
        "v0.9.10",
        "v0.10.0",
      ])
    ).toThrow(/newer/);
    // A pre-release that became npm's latest by mistake.
    expect(() =>
      releaseAction(
        "v0.5.4",
        "0.5.4",
        { versions: ["0.6.0-rc.1"], latest: "0.6.0-rc.1" },
        ["v0.5.4"]
      )
    ).toThrow(/below npm's latest 0\.6\.0-rc\.1/);
    expect(
      releaseAction(
        "v0.6.0",
        "0.6.0",
        { versions: ["0.6.0-rc.1"], latest: "0.6.0-rc.1" },
        ["v0.6.0"]
      )
    ).toBe("publish");
  });

  it("publishes when npm has versions but no latest tag", () => {
    expect(
      releaseAction("v0.5.4", "0.5.4", { versions: ["0.5.3"], latest: null }, [
        "v0.5.4",
      ])
    ).toBe("publish");
  });
});

describe("npmState", () => {
  it("reads npm's versions and latest, the scope's slash encoded", async () => {
    const fetchImpl = answer(200, {
      "dist-tags": { latest: "0.5.3" },
      versions: { "0.5.2": {}, "0.5.3": {} },
    });
    expect(await npmState("@evoscientist/webui", fetchImpl)).toEqual({
      versions: ["0.5.2", "0.5.3"],
      latest: "0.5.3",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://registry.npmjs.org/@evoscientist%2fwebui"
    );
  });

  it("is null for a package npm doesn't have", async () => {
    expect(await npmState("@evoscientist/webui", answer(404))).toBeNull();
  });

  it("throws on any other answer rather than publish blind", async () => {
    await expect(npmState("@evoscientist/webui", answer(503))).rejects.toThrow(
      /503/
    );
    for (const body of [
      null,
      {},
      { versions: [] },
      { versions: {}, "dist-tags": 1 },
    ]) {
      await expect(
        npmState("@evoscientist/webui", answer(200, body)),
        JSON.stringify(body)
      ).rejects.toThrow(/registry/);
    }
    await expect(
      npmState(
        "@evoscientist/webui",
        answer(200, { versions: {}, "dist-tags": { latest: "next" } })
      )
    ).rejects.toThrow(/latest/);
  });
});

describe("releaseTags", () => {
  it("reads the v* tags from git ls-remote", () => {
    const out = [
      "a1\trefs/tags/v0.5.2",
      "b2\trefs/tags/v0.5.3",
      "c3\trefs/tags/W04Test-1",
      "",
    ].join("\n");
    expect(releaseTags(out)).toEqual(["v0.5.2", "v0.5.3"]);
  });
});

// What the publish job sends is the pack job's tarball: its own package.json
// must be the version the tag names, whatever the build did. npm reads the
// manifest from any one folder of the tarball, so every entry must be in
// package/.
describe("packedProblem", () => {
  const pkg = { name: "@evoscientist/webui", version: "0.5.4" };
  const entries = ["package/package.json", "package/dist/server.js"];

  it("accepts the tarball of this name and version", () => {
    expect(packedProblem({ entries, manifest: { ...pkg } }, pkg)).toBeNull();
  });

  it("names another version or name, or a missing package.json", () => {
    expect(
      packedProblem({ entries, manifest: { ...pkg, version: "0.5.999" } }, pkg)
    ).toMatch(
      /holds @evoscientist\/webui@0\.5\.999, not @evoscientist\/webui@0\.5\.4/
    );
    expect(
      packedProblem({ entries, manifest: { ...pkg, name: "other" } }, pkg)
    ).toMatch(/holds other@/);
    expect(packedProblem({ entries, manifest: null }, pkg)).toMatch(
      /no package\.json/
    );
    expect(packedProblem(null, pkg)).toMatch(/could not be read/);
  });

  it("refuses an entry outside package/", () => {
    expect(
      packedProblem(
        { entries: [...entries, "x/package.json"], manifest: { ...pkg } },
        pkg
      )
    ).toMatch(/x\/package\.json outside package\//);
  });

  // npm reads package/./package.json and package//package.json as
  // package/package.json; the last of them wins.
  it("refuses an entry npm would read under another name, or twice", () => {
    for (const odd of [
      "package/./package.json",
      "package//package.json",
      "package/x/../package.json",
      "package\\package.json",
      "package/dist\\server.js",
      "package/package.json",
    ]) {
      expect(
        packedProblem(
          { entries: [...entries, odd], manifest: { ...pkg } },
          pkg
        ),
        odd
      ).toMatch(/odd entry|twice|outside package/);
    }
    // A folder entry ends in a slash.
    expect(
      packedProblem(
        {
          entries: ["package/", "package/dist/", ...entries],
          manifest: { ...pkg },
        },
        pkg
      )
    ).toBeNull();
  });
});

describe("parseArgs", () => {
  it("reads the tag and an optional tarball", () => {
    expect(parseArgs(["v0.5.4"])).toEqual({
      tag: "v0.5.4",
      tarball: undefined,
    });
    expect(parseArgs(["v0.5.4", "--tarball", "a.tgz"])).toEqual({
      tag: "v0.5.4",
      tarball: "a.tgz",
    });
  });

  // A tarball named but missing would skip the tarball's check.
  it("refuses --tarball without a file, and anything else", () => {
    expect(() => parseArgs(["v0.5.4", "--tarball"])).toThrow(/--tarball/);
    expect(() => parseArgs(["v0.5.4", "--tarball", "--x"])).toThrow(
      /--tarball/
    );
    expect(() => parseArgs(["v0.5.4", "extra"])).toThrow(/extra/);
    expect(() => parseArgs([])).toThrow(/tag/);
  });
});

/** A gzipped tar of `files`, written byte by byte, so an entry keeps the
 *  exact name given (a tar program could normalise it). */
function tarball(files: [string, string][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of files) {
    const data = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
    blocks.push(header, data, pad);
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// The release runs on Linux; on Windows `tar` and `npm` are other programs.
describe.runIf(process.platform !== "win32")("readPackedFile", () => {
  const manifest = (version: string) =>
    JSON.stringify({ name: "@evoscientist/webui", version });
  const pkg = { name: "@evoscientist/webui", version: "0.5.4" };
  const withTarball = (
    files: [string, string][],
    test: (tgz: string) => void
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "npm-check-"));
    try {
      const tgz = join(dir, "p.tgz");
      writeFileSync(tgz, tarball(files));
      test(tgz);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("reads the entries, and the name and version npm sees", () => {
    withTarball(
      [
        ["package/package.json", manifest("0.5.4")],
        ["package/dist/server.js", ""],
      ],
      (tgz) => {
        const packed = readPackedFile(tgz);
        expect(packed.entries).toEqual([
          "package/package.json",
          "package/dist/server.js",
        ]);
        expect(packed.manifest).toEqual({ name: pkg.name, version: "0.5.4" });
        expect(packedProblem(packed, pkg)).toBeNull();
      }
    );
  });

  // npm 11 reads the second manifest from each of these and would publish
  // 0.5.999; npm 10 reads the first one beside `package//package.json`. The
  // entry rules refuse each tarball, whichever manifest npm reads.
  it("refuses a second manifest, whichever one npm reads", () => {
    for (const second of [
      "package/./package.json",
      "package//package.json",
      "x/package.json",
    ]) {
      withTarball(
        [
          ["package/package.json", manifest("0.5.4")],
          [second, manifest("0.5.999")],
        ],
        (tgz) => {
          const packed = readPackedFile(tgz);
          expect(["0.5.4", "0.5.999"], second).toContain(
            packed.manifest?.version
          );
          expect(packedProblem(packed, pkg), second).toMatch(
            /outside package\/|odd entry/
          );
        }
      );
    }
  });

  it("refuses a tarball whose manifest names another version", () => {
    withTarball([["package/package.json", manifest("0.5.999")]], (tgz) => {
      const packed = readPackedFile(tgz);
      expect(packed.manifest).toEqual({ name: pkg.name, version: "0.5.999" });
      expect(packedProblem(packed, pkg)).toBe(
        "the tarball holds @evoscientist/webui@0.5.999, not @evoscientist/webui@0.5.4"
      );
    });
  });
});

describe("main", () => {
  const deps = (npm: Awaited<ReturnType<typeof npmState>>) => {
    const written: string[] = [];
    const logged: string[] = [];
    return {
      written,
      logged,
      run: () =>
        main({
          tag: "v0.5.4",
          pkg: { name: "@evoscientist/webui", version: "0.5.4" },
          readNpm: async () => npm,
          readTags: () => ["v0.5.3", "v0.5.4"],
          writeOutput: (line: string) => written.push(line),
          log: (line: string) => logged.push(line),
        }),
    };
  };
  const npm053 = { versions: ["0.5.3"], latest: "0.5.3" };

  it("checks a tarball it is given before it says to publish", async () => {
    const written: string[] = [];
    const run = (version: string) =>
      main({
        tag: "v0.5.4",
        pkg: { name: "@evoscientist/webui", version: "0.5.4" },
        readNpm: async () => npm053,
        readTags: () => ["v0.5.4"],
        tarball: "npm-package/evoscientist-webui-0.5.4.tgz",
        readPacked: (file: string) => {
          expect(file).toBe("npm-package/evoscientist-webui-0.5.4.tgz");
          return {
            entries: ["package/package.json"],
            manifest: { name: "@evoscientist/webui", version },
          };
        },
        writeOutput: (line: string) => written.push(line),
        log: () => {},
      });
    await run("0.5.4");
    expect(written).toEqual(["action=publish"]);
    await expect(run("0.5.999")).rejects.toThrow(/0\.5\.999/);
    expect(written).toEqual(["action=publish"]);
  });

  // Without the output the later steps would skip and the job would end
  // green with nothing published.
  it("writes what it decided to the step's output", async () => {
    const publish = deps({ versions: ["0.5.3"], latest: "0.5.3" });
    await publish.run();
    expect(publish.written).toEqual(["action=publish"]);
    expect(publish.logged.join("\n")).toMatch(/0\.5\.4 goes to npm/);
    const skip = deps({ versions: ["0.5.4"], latest: "0.5.4" });
    await skip.run();
    expect(skip.written).toEqual(["action=skip"]);
  });
});
