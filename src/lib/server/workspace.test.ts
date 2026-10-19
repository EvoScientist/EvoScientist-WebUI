import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { type Dirent, promises as fs } from "fs";
import type { FileHandle } from "fs/promises";
import { Readable } from "stream";
import { tmpdir } from "os";
import { basename, join } from "path";
import { inflateRawSync } from "zlib";
import { NextRequest } from "next/server";
import {
  isCrossOrigin,
  workspaceArchivePath,
  zipWorkspace,
} from "@/lib/server/workspace";

// The first NextRequest argument is the server's own view of the URL. In the
// standalone server that origin comes from the configured HOSTNAME (not the
// address in the browser), so building requests on http://0.0.0.0:4716 while
// the Host header says localhost reproduces the #35 production mismatch.
function req(headers: Record<string, string>) {
  return new NextRequest("http://0.0.0.0:4716/api/workspace/upload", {
    method: "POST",
    headers,
  });
}

describe("isCrossOrigin", () => {
  it("allows same-origin writes when nextUrl is pinned to a wildcard HOSTNAME (#35)", () => {
    expect(
      isCrossOrigin(
        req({ host: "localhost:4716", origin: "http://localhost:4716" })
      )
    ).toBe(false);
  });

  it("allows LAN visitors whose Origin matches the Host they connected to", () => {
    expect(
      isCrossOrigin(
        req({ host: "192.168.1.10:4716", origin: "http://192.168.1.10:4716" })
      )
    ).toBe(false);
  });

  it("trusts Sec-Fetch-Site: same-origin without consulting Origin", () => {
    expect(
      isCrossOrigin(
        req({
          "sec-fetch-site": "same-origin",
          host: "localhost:4716",
          origin: "http://localhost:4716",
        })
      )
    ).toBe(false);
  });

  it.each(["same-site", "none"])("allows Sec-Fetch-Site: %s", (site) => {
    expect(
      isCrossOrigin(req({ "sec-fetch-site": site, host: "localhost:4716" }))
    ).toBe(false);
  });

  it("rejects Sec-Fetch-Site: cross-site even when Origin matches Host", () => {
    expect(
      isCrossOrigin(
        req({
          "sec-fetch-site": "cross-site",
          host: "localhost:4716",
          origin: "http://localhost:4716",
        })
      )
    ).toBe(true);
  });

  it("rejects an Origin whose host differs from the request Host", () => {
    expect(
      isCrossOrigin(
        req({ host: "localhost:4716", origin: "http://evil.example" })
      )
    ).toBe(true);
  });

  it("allows requests with neither Sec-Fetch-Site nor Origin", () => {
    expect(isCrossOrigin(req({ host: "localhost:4716" }))).toBe(false);
  });

  it("rejects an opaque or malformed Origin", () => {
    expect(isCrossOrigin(req({ host: "localhost:4716", origin: "null" }))).toBe(
      true
    );
  });

  it("rejects a missing Host even when Sec-Fetch-Site claims same-origin", () => {
    expect(isCrossOrigin(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("rejects a request with no Host header at all", () => {
    expect(isCrossOrigin(req({}))).toBe(true);
  });
});

interface ZipEntry {
  name: string;
  utf8: boolean;
  data: string;
}

// Reads an archive's central directory by hand, so the test doesn't depend on
// an unzip tool (the point of zipWorkspace is not needing one).
async function readZip(file: string): Promise<ZipEntry[]> {
  const buf = await fs.readFile(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localHeader = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    const dataStart =
      localHeader +
      30 +
      buf.readUInt16LE(localHeader + 26) +
      buf.readUInt16LE(localHeader + 28);
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    entries.push({ name, utf8: (flags & 0x800) !== 0, data: data.toString() });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

describe("zipWorkspace", () => {
  let root: string;
  let workspace: string;
  let outFile: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "zip-workspace-test-"));
    workspace = join(root, "ws");
    outFile = join(root, "out.zip");
    await fs.mkdir(workspace);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = async (rel: string, text: string) => {
    await fs.mkdir(join(workspace, rel, ".."), { recursive: true });
    await fs.writeFile(join(workspace, rel), text);
  };

  it("archives the files the tree shows, with their contents", async () => {
    await write("report.md", "# findings");
    await write("data/results.csv", "a,b\n1,2");
    await write("笔记.md", "中文笔记");
    await write(".env", "SECRET=1");
    await write("data/.cache/x", "hidden");
    await write("__pycache__/m.cpython-312.pyc", "bytecode");
    await write("src/model.pyc", "bytecode");
    await write("node_modules/pkg/index.js", "dep");
    await write("large_tool_results/call_1.json", "{}");

    await zipWorkspace(workspace, outFile);

    expect(await readZip(outFile)).toEqual([
      { name: "data/results.csv", utf8: true, data: "a,b\n1,2" },
      { name: "report.md", utf8: true, data: "# findings" },
      { name: "src/", utf8: true, data: "" },
      { name: "笔记.md", utf8: true, data: "中文笔记" },
    ]);
  });

  // A link to a file or folder outside the workspace must not put that
  // content in the archive.
  // (Windows needs a privilege to create symlinks.)
  it.skipIf(process.platform === "win32")("leaves out symlinks", async () => {
    const outside = join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, "secret.txt"), "outside");
    await write("kept.txt", "inside");
    await fs.symlink(join(outside, "secret.txt"), join(workspace, "link.txt"));
    await fs.symlink(outside, join(workspace, "linked-dir"));

    await zipWorkspace(workspace, outFile);

    expect((await readZip(outFile)).map((e) => e.name)).toEqual(["kept.txt"]);
  });

  // Makes the walk see entries as they were a moment earlier (`as` per name),
  // to stand in for a swap between reading a folder and using what it listed.
  const pretend = (as: Record<string, "file" | "dir">) => {
    const readdir = fs.readdir.bind(fs);
    return vi.spyOn(fs, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fs.readdir>
    ) => {
      const dirents = (await readdir(...args)) as unknown as Dirent[];
      return dirents.map((d) =>
        as[d.name]
          ? Object.assign(Object.create(d), {
              name: d.name,
              isSymbolicLink: () => false,
              isFile: () => as[d.name] === "file",
              isDirectory: () => as[d.name] === "dir",
            })
          : d
      );
    }) as typeof fs.readdir);
  };
  // (Windows needs a privilege to create symlinks.)
  it.skipIf(process.platform === "win32")(
    "does not follow a link that replaced a file after the walk",
    async () => {
      await fs.writeFile(join(root, "secret.txt"), "outside");
      await fs.symlink(
        join(root, "secret.txt"),
        join(workspace, "swapped.txt")
      );
      const spy = pretend({ "swapped.txt": "file" });
      try {
        await zipWorkspace(workspace, outFile);
      } finally {
        spy.mockRestore();
      }
      expect(await readZip(outFile)).toEqual([]);
    }
  );

  // O_NOFOLLOW guards only the last part of a path; a folder on the way must
  // still resolve inside the workspace.
  it.skipIf(process.platform === "win32")(
    "does not follow a link that replaced a folder after the walk",
    async () => {
      await fs.mkdir(join(root, "outside"));
      await fs.writeFile(join(root, "outside", "secret.txt"), "outside");
      await fs.symlink(join(root, "outside"), join(workspace, "sub"));
      const spy = pretend({ sub: "dir" });
      try {
        await zipWorkspace(workspace, outFile);
      } finally {
        spy.mockRestore();
      }
      expect(await readZip(outFile)).toEqual([]);
    }
  );

  // Opening a FIFO for reading waits for a writer; the download must not hang.
  it.skipIf(process.platform === "win32")(
    "skips a FIFO that replaced a file instead of waiting on it",
    async () => {
      await write("kept.txt", "inside");
      execFileSync("mkfifo", [join(workspace, "pipe.txt")]);
      const spy = pretend({ "pipe.txt": "file" });
      try {
        await zipWorkspace(workspace, outFile);
      } finally {
        spy.mockRestore();
      }
      expect((await readZip(outFile)).map((e) => e.name)).toEqual(["kept.txt"]);
    }
  );

  // With the temp dir inside the workspace, the archive must not read itself.
  it("leaves out the archive being written", async () => {
    await write("report.md", "# findings");

    await zipWorkspace(workspace, join(workspace, "out.zip"));

    expect(
      (await readZip(join(workspace, "out.zip"))).map((e) => e.name)
    ).toEqual(["report.md"]);
  });

  // `zip -r` skips a folder it can't read; one such folder mustn't cost the
  // whole download. (chmod has no effect for root or on Windows.)
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "skips a folder it can't read",
    async () => {
      await write("report.md", "# findings");
      await write("locked/secret.txt", "x");
      await fs.chmod(join(workspace, "locked"), 0o000);
      try {
        await zipWorkspace(workspace, outFile);
      } finally {
        await fs.chmod(join(workspace, "locked"), 0o755);
      }
      expect((await readZip(outFile)).map((e) => e.name)).toEqual([
        "report.md",
      ]);
    }
  );

  // Fails `fs.open` of workspace files whose path ends with `name`.
  const failOpen = (name: string, code: string) => {
    const open = fs.open.bind(fs);
    return vi.spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      if (String(args[0]).endsWith(name)) {
        throw Object.assign(new Error(`${code}: ${name}`), { code });
      }
      return open(...args);
    }) as typeof fs.open);
  };

  // A running job may delete a file between its folder being read and the file
  // being opened; on Windows a file being deleted answers EPERM.
  it.each(["ENOENT", "EACCES", "EPERM", "EBUSY"])(
    "skips a file it can't open (%s)",
    async (code) => {
      await write("gone.txt", "x");
      await write("report.md", "# findings");
      const spy = failOpen("gone.txt", code);
      try {
        await zipWorkspace(workspace, outFile);
      } finally {
        spy.mockRestore();
      }
      expect((await readZip(outFile)).map((e) => e.name)).toEqual([
        "report.md",
      ]);
    }
  );

  // A disk error must not turn into a 200 with files silently missing.
  it("fails on an I/O error opening a file", async () => {
    await write("report.md", "# findings");
    const spy = failOpen("report.md", "EIO");
    try {
      await expect(zipWorkspace(workspace, outFile)).rejects.toThrow("EIO");
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ["EIO reading the workspace", "", "EIO"],
    ["EIO reading a folder", "data", "EIO"],
    // A sub-folder without permission is skipped; the workspace itself isn't.
    ["EACCES reading the workspace", "", "EACCES"],
  ])("fails on %s", async (_label, folder, code) => {
    await write("data/results.csv", "a,b");
    const readdir = fs.readdir.bind(fs);
    const spy = vi.spyOn(fs, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fs.readdir>
    ) => {
      const path = String(args[0]);
      if (folder ? basename(path) === folder : basename(path) !== "data") {
        throw Object.assign(new Error(`${code}: read failed`), { code });
      }
      return readdir(...args);
    }) as typeof fs.readdir);
    try {
      await expect(zipWorkspace(workspace, outFile)).rejects.toThrow(code);
    } finally {
      spy.mockRestore();
    }
  });

  // Names a zip can't hold as they are: `\` is a separator in zip paths and
  // `C:` reads as a drive. (Neither is a valid Windows file name.)
  it.skipIf(process.platform === "win32")(
    "skips names a zip can't hold, keeping the rest",
    async () => {
      await write("report.md", "# findings");
      await write("a/b.txt", "real");
      await write("a\\b.txt", "backslash");
      await write("C:notes.md", "drive");
      await fs.mkdir(join(workspace, "C:folder"));

      await zipWorkspace(workspace, outFile);

      expect(await readZip(outFile)).toEqual([
        { name: "a/b.txt", utf8: true, data: "real" },
        { name: "report.md", utf8: true, data: "# findings" },
      ]);
    }
  );

  // Workspace files open as `stream` (with the real file's stat, so the check
  // after opening passes); the archive itself opens for real.
  const fakeOpen = (
    stream: Readable,
    opts: { close?: () => Promise<void>; stat?: () => Promise<unknown> } = {}
  ) => {
    const open = fs.open.bind(fs);
    const lstat = fs.lstat.bind(fs);
    return vi.spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) =>
      String(args[0]) === outFile
        ? open(...args)
        : ({
            stat: opts.stat ?? (() => lstat(String(args[0]), { bigint: true })),
            createReadStream: () => stream,
            close: opts.close ?? (async () => {}),
          } as unknown as FileHandle)) as typeof fs.open);
  };

  it("closes the file when reading its details fails", async () => {
    await write("report.md", "# findings");
    const close = vi.fn(async () => {});
    const spy = fakeOpen(new Readable({ read() {} }), {
      close,
      stat: async () => {
        throw Object.assign(new Error("EIO: stat failed"), { code: "EIO" });
      },
    });
    try {
      await expect(zipWorkspace(workspace, outFile)).rejects.toThrow("EIO");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  // yazl leaves a stream's errors to the caller; unhandled, a read error
  // would be an uncaught exception in the server.
  it("rejects when reading a file fails", async () => {
    await write("report.md", "# findings");
    const spy = fakeOpen(
      new Readable({
        read() {
          this.destroy(new Error("EIO: read failed"));
        },
      })
    );
    try {
      await expect(zipWorkspace(workspace, outFile)).rejects.toThrow(
        "EIO: read failed"
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("closes the file being read and stops when the request is aborted", async () => {
    await write("big.bin", "x");
    await write("next.bin", "y");
    let opened!: () => void;
    const isOpen = new Promise<void>((r) => (opened = r));
    const endless = new Readable({
      read() {
        opened();
      },
    });
    const spy = fakeOpen(endless);
    const controller = new AbortController();
    try {
      const done = zipWorkspace(workspace, outFile, controller.signal);
      await isOpen;
      controller.abort();
      await expect(done).rejects.toThrow("Request aborted.");
      expect(endless.destroyed).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      const workspaceOpens = spy.mock.calls.filter(
        ([path]) => String(path) !== outFile
      );
      expect(workspaceOpens).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("closes a file opened just as the request is aborted", async () => {
    await write("report.md", "# findings");
    await write("next.md", "more");
    const controller = new AbortController();
    const closes: string[] = [];
    const reads: string[] = [];
    const open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await open(...args);
      if (String(args[0]) === outFile) return handle;
      controller.abort(); // the client leaves while this open is under way
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closes.push(String(args[0]));
        return close();
      };
      const createReadStream = handle.createReadStream.bind(handle);
      handle.createReadStream = (...rest) => {
        reads.push(String(args[0]));
        return createReadStream(...rest);
      };
      return handle;
    }) as typeof fs.open);
    try {
      await expect(
        zipWorkspace(workspace, outFile, controller.signal)
      ).rejects.toThrow("Request aborted.");
      await new Promise((r) => setTimeout(r, 50));
      const opened = spy.mock.calls.filter(([p]) => String(p) !== outFile);
      expect(opened).toHaveLength(1);
      expect(reads).toEqual([]);
      expect(closes).toEqual([String(opened[0][0])]);
    } finally {
      spy.mockRestore();
    }
  });

  it("stops when the request is aborted while it starts", async () => {
    await write("report.md", "# findings");
    const controller = new AbortController();
    const realpath = fs.realpath.bind(fs);
    const spy = vi.spyOn(fs, "realpath").mockImplementation((async (
      ...args: Parameters<typeof fs.realpath>
    ) => {
      controller.abort();
      return realpath(...args);
    }) as typeof fs.realpath);
    try {
      await expect(
        zipWorkspace(workspace, outFile, controller.signal)
      ).rejects.toThrow("Request aborted.");
    } finally {
      spy.mockRestore();
    }
  });

  // Two downloads at once with the temp dir inside the workspace: neither may
  // read the other's archive as it grows.
  it("keeps concurrent archives out of each other", async () => {
    await write("report.md", "# findings");
    const a = workspaceArchivePath(workspace);
    const b = workspaceArchivePath(workspace);

    await Promise.all([zipWorkspace(workspace, a), zipWorkspace(workspace, b)]);

    expect((await readZip(a)).map((e) => e.name)).toEqual(["report.md"]);
    expect((await readZip(b)).map((e) => e.name)).toEqual(["report.md"]);
  });

  // A folder on the way swapped for a link between the inside-the-workspace
  // check and the open: the file opened is then outside, and must be dropped.
  it.skipIf(process.platform === "win32")(
    "drops a file reached through a folder swapped for a link at open time",
    async () => {
      await write("sub/data.txt", "inside");
      await fs.mkdir(join(root, "outside"));
      await fs.writeFile(join(root, "outside", "data.txt"), "outside");
      const open = fs.open.bind(fs);
      const spy = vi.spyOn(fs, "open").mockImplementation((async (
        ...args: Parameters<typeof fs.open>
      ) => {
        if (String(args[0]).endsWith("/sub/data.txt")) {
          await fs.rename(join(workspace, "sub"), join(root, "sub-moved"));
          await fs.symlink(join(root, "outside"), join(workspace, "sub"));
        }
        return open(...args);
      }) as typeof fs.open);
      try {
        await zipWorkspace(workspace, outFile);
      } finally {
        spy.mockRestore();
      }
      const entries = await readZip(outFile);
      expect(entries.map((e) => e.data)).not.toContain("outside");
    }
  );

  // The check that a path is inside the workspace resolves it on disk; a disk
  // error there must fail the download like any other, not drop the file.
  it.each([
    ["skips a file whose path no longer resolves", "ENOENT"],
    ["skips a file whose path is too long to resolve", "ENAMETOOLONG"],
    ["fails on an I/O error resolving a path", "EIO"],
  ])("%s (%s)", async (_label, code) => {
    await write("report.md", "# findings");
    await write("data/results.csv", "a,b");
    const realpath = fs.realpath.bind(fs);
    const spy = vi.spyOn(fs, "realpath").mockImplementation((async (
      ...args: Parameters<typeof fs.realpath>
    ) => {
      if (basename(String(args[0])) === "results.csv") {
        throw Object.assign(new Error(`${code}: realpath`), { code });
      }
      return realpath(...args);
    }) as typeof fs.realpath);
    try {
      const done = zipWorkspace(workspace, outFile);
      if (code === "EIO") {
        await expect(done).rejects.toThrow("EIO");
      } else {
        await done;
        expect((await readZip(outFile)).map((e) => e.name)).toEqual([
          "data/",
          "report.md",
        ]);
      }
    } finally {
      spy.mockRestore();
    }
  });

  // Only a cause whose code is known to mean "this entry is gone or refused"
  // leaves a file out; anything else behind a refusal fails the download.
  it("fails when resolving a path fails without an error code", async () => {
    await write("report.md", "# findings");
    const realpath = fs.realpath.bind(fs);
    const spy = vi.spyOn(fs, "realpath").mockImplementation((async (
      ...args: Parameters<typeof fs.realpath>
    ) => {
      if (basename(String(args[0])) === "report.md") {
        throw new Error("unclassified failure");
      }
      return realpath(...args);
    }) as typeof fs.realpath);
    try {
      await expect(zipWorkspace(workspace, outFile)).rejects.toThrow(
        "unclassified failure"
      );
    } finally {
      spy.mockRestore();
    }
  });

  // Only a refusal (outside or hidden path) or a listed code leaves a file out.
  it("fails on an error without a code from opening a file", async () => {
    await write("report.md", "# findings");
    const open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      if (basename(String(args[0])) === "report.md") {
        throw new Error("open failed without a code");
      }
      return open(...args);
    }) as typeof fs.open);
    try {
      await expect(zipWorkspace(workspace, outFile)).rejects.toThrow(
        "open failed without a code"
      );
    } finally {
      spy.mockRestore();
    }
  });

  // The temp dir may be shared with other users of the machine.
  it.skipIf(process.platform === "win32")(
    "writes the archive readable by its owner only",
    async () => {
      await write("report.md", "# findings");

      await zipWorkspace(workspace, outFile);

      expect((await fs.stat(outFile)).mode & 0o777).toBe(0o600);
    }
  );

  // The route deletes the archive once this rejects; on Windows a file still
  // open can't be deleted, so the archive must be closed first.
  it("rejects only once the archive file is closed", async () => {
    await write("big.bin", "x");
    let archiveClosed = false;
    const open = fs.open.bind(fs);
    const lstat = fs.lstat.bind(fs);
    const controller = new AbortController();
    const spy = vi.spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      if (String(args[0]) === outFile) {
        const handle = await open(...args);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          archiveClosed = true;
        };
        return handle;
      }
      return {
        stat: () => lstat(String(args[0]), { bigint: true }),
        createReadStream: () =>
          new Readable({
            read() {
              controller.abort();
            },
          }),
        close: async () => {},
      } as unknown as FileHandle;
    }) as typeof fs.open);
    try {
      await expect(
        zipWorkspace(workspace, outFile, controller.signal).catch((error) => {
          expect(archiveClosed).toBe(true);
          throw error;
        })
      ).rejects.toThrow("Request aborted.");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps empty folders, as the tree shows them", async () => {
    await fs.mkdir(join(workspace, "results", "empty"), { recursive: true });

    await zipWorkspace(workspace, outFile);

    expect((await readZip(outFile)).map((e) => e.name)).toEqual([
      "results/empty/",
    ]);
  });

  it("gives an empty archive for an empty workspace", async () => {
    await zipWorkspace(workspace, outFile);

    expect(await readZip(outFile)).toEqual([]);
  });

  it("stops when the request is aborted", async () => {
    await write("report.md", "# findings");
    const controller = new AbortController();
    controller.abort();

    await expect(
      zipWorkspace(workspace, outFile, controller.signal)
    ).rejects.toThrow("Request aborted.");
  });
});
