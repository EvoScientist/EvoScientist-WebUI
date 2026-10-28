// Server-only helpers for the on-disk folder of a project the local
// EvoScientist backend serves (lib/server/projects.ts finds it). Shared by
// the workspace upload/list/read API routes.
//
// The "workspace" is a project's folder (where the agent reads/writes real
// files via its file tools). It is NOT the agent's in-memory `files` state —
// that lives in thread state and is managed through the SDK.

import {
  type BigIntStats,
  constants as fsConstants,
  type Dirent,
  promises as fs,
} from "fs";
import type { FileHandle } from "fs/promises";
import { networkInterfaces, tmpdir } from "os";
import { basename, dirname, join, relative, resolve, sep } from "path";
import type { Readable } from "stream";
import { ZipFile } from "yazl";
import { randomUUID } from "crypto";
import type { NextRequest } from "next/server";
import { isLoopbackHost } from "@/lib/backendBoundary";
import { readCoreConfig } from "@/lib/server/coreConfig";

/** True if the name contains any C0/C1 control char, DEL, or a line/paragraph
 *  separator. A newline in a filename would otherwise be spliced into the
 *  prompt sent to the agent (instruction injection); control chars have no
 *  place in a filename. */
export function hasControlChar(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (
      code < 0x20 || // C0 controls (incl. NUL, tab, newline)
      code === 0x7f || // DEL
      (code >= 0x80 && code <= 0x9f) || // C1 controls
      code === 0x2028 || // line separator
      code === 0x2029 // paragraph separator
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// What the workspace browser hides
//
// Single source of truth for "noise" the file tree, direct file access, and the
// download-all zip all agree on. Edit these lists to change what's shown.
// Matched case-sensitively against each path segment.
// ---------------------------------------------------------------------------

/** Exact entry names treated as internal/noise — never research artifacts. */
export const IGNORED_NAMES = new Set([
  "large_tool_results", // EvoScientist: large tool outputs spilled to disk, keyed by call id
  "conversation_history", // EvoScientist: internal conversation transcripts
  "__pycache__", // Python bytecode cache
  "node_modules", // JS deps
  "__MACOSX", // macOS archive cruft
]);

/** Filename suffixes hidden the same way (build artifacts). */
export const IGNORED_SUFFIXES = [".pyc", ".pyo"];

/**
 * True if a single entry name should be hidden from the workspace browser:
 * dotfiles (incl. `.langgraph_api`, `.DS_Store`), known-internal directories,
 * and build artifacts. Used for both listings and direct-access blocking.
 */
export function isHiddenEntry(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (IGNORED_NAMES.has(name)) return true;
  return IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

// Not defined on Windows, where the check after each open is the guard.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
// Opening a FIFO for reading would otherwise wait for a writer.
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

/** Errors that leave one entry out of the archive: gone, now a link, a path
 *  too long to resolve, or not permitted (Windows answers EPERM for a file
 *  being deleted). Any other error, such as EIO, fails the download instead of
 *  quietly losing files. */
const SKIPPABLE_CODES = new Set([
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "EACCES",
  "EPERM",
  "EBUSY",
]);

/** Whether `error` leaves one entry out rather than failing the download: a
 *  refused path (outside or hidden; when resolving it failed, only a listed
 *  code), or an error with a listed code. */
function leavesOut(error: unknown): boolean {
  const reason = error instanceof PathRefusedError ? error.cause : error;
  if (reason === undefined) return true;
  return SKIPPABLE_CODES.has((reason as NodeJS.ErrnoException).code ?? "");
}

/** The error to fail with: the disk error behind a safeResolve refusal. */
const failure = (error: unknown) =>
  (error as { cause?: unknown }).cause ?? error;

/** Where the download route writes its archive. The dot name keeps it out of
 *  listings, direct access and other downloads' archives when the temp dir
 *  lies inside the workspace. */
export function workspaceArchivePath(dir = tmpdir()): string {
  return join(dir, `.evoscientist-workspace-${randomUUID()}.zip`);
}

interface ZipRun {
  zip: ZipFile;
  root: string;
  /** The archive itself, in case its path is inside the workspace. */
  self: BigIntStats;
  stopped: () => boolean;
  reading: (stream: Readable | null) => void;
}

// Some SMB shares give every file ino 0: never take that for the archive (and
// there `stillInside` can only compare the volume).
const sameFile = (a: BigIntStats, b: BigIntStats) =>
  a.ino !== BigInt(0) && a.dev === b.dev && a.ino === b.ino;

/** True while `rel` still resolves inside the workspace to the file `st`
 *  describes. Checked after the open: a folder on the way swapped for a link
 *  between the earlier check and the open would have led outside. */
async function stillInside(
  run: ZipRun,
  rel: string,
  st: BigIntStats
): Promise<boolean> {
  try {
    const now = await fs.lstat(await safeResolve(run.root, rel), {
      bigint: true,
    });
    return now.dev === st.dev && now.ino === st.ino;
  } catch (error) {
    if (leavesOut(error)) return false;
    throw failure(error);
  }
}

/** Opens a file for the archive right before it is added, or returns null when
 *  it is gone, not permitted, outside the workspace, or no longer a regular
 *  file (renamed, or swapped for a link or a FIFO since the walk). */
async function openForZip(
  run: ZipRun,
  rel: string
): Promise<{ handle: FileHandle; st: BigIntStats } | null> {
  let real: string;
  try {
    real = await safeResolve(run.root, rel);
  } catch (error) {
    if (leavesOut(error)) return null;
    throw failure(error);
  }
  let handle: FileHandle;
  try {
    handle = await fs.open(
      real,
      fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK
    );
  } catch (error) {
    if (leavesOut(error)) return null;
    throw error;
  }
  let kept = false;
  try {
    const st = await handle.stat({ bigint: true });
    if (
      st.isFile() &&
      !sameFile(st, run.self) &&
      (await stillInside(run, rel, st))
    ) {
      kept = true;
      return { handle, st };
    }
    return null;
  } finally {
    if (!kept) await handle.close();
  }
}

/** Adds what the tree shows under `rel`, one file at a time: hidden entries and
 *  links left out, empty folders kept. Returns whether it added anything, or
 *  null when a sub-folder can't be read (skipped, as `zip -r` does). */
async function addTree(run: ZipRun, rel: string): Promise<boolean | null> {
  let dirents: Dirent[];
  try {
    // A sub-folder is re-resolved inside the workspace, so one swapped for a
    // link since its parent was read isn't followed out.
    const dir = rel ? await safeResolve(run.root, rel) : run.root;
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A sub-folder may be left out; the workspace itself must be read.
    if (rel && leavesOut(error)) return null;
    throw failure(error);
  }
  let added = false;
  for (const dirent of dirents) {
    if (run.stopped()) break;
    // A link could point outside the workspace. A zip can't hold `\` (a path
    // separator there) or a leading `C:` (read as a drive), so those names go.
    if (
      isHiddenEntry(dirent.name) ||
      dirent.isSymbolicLink() ||
      dirent.name.includes("\\") ||
      (!rel && /^[a-zA-Z]:/.test(dirent.name))
    ) {
      continue;
    }
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      const sub = await addTree(run, childRel);
      if (sub === false) run.zip.addEmptyDirectory(childRel);
      if (sub !== null) added = true;
    } else if (dirent.isFile()) {
      const opened = await openForZip(run, childRel);
      if (!opened) continue;
      if (run.stopped()) {
        // The client left while this file was being opened.
        await opened.handle.close();
        break;
      }
      const stream = opened.handle.createReadStream();
      // yazl leaves a stream's errors to its caller; unhandled, one would be
      // an uncaught exception in the server.
      stream.on("error", (error) => run.zip.emit("error", error));
      const closed = new Promise<void>((done) =>
        stream.once("close", () => done())
      );
      run.zip.addReadStream(stream, childRel, {
        mtime: opened.st.mtime,
        mode: Number(opened.st.mode),
      });
      run.reading(stream);
      await closed;
      run.reading(null);
      added = true;
    }
  }
  return added;
}

/** Zips what the workspace tree shows into `outFile`, in process (no OS `zip`,
 *  which Windows lacks). Rejects if `signal` fires, e.g. the client leaves. */
export async function zipWorkspace(
  root: string,
  outFile: string,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new Error("Request aborted.");
  const realRoot = await fs.realpath(root);
  // Owner-only: the temp dir may be shared with other users of the machine.
  const target = await fs.open(outFile, "wx", 0o600);
  let self: BigIntStats;
  try {
    self = await target.stat({ bigint: true });
  } catch (error) {
    await target.close();
    throw error;
  }
  const out = target.createWriteStream();
  const zip = new ZipFile();
  return new Promise((resolvePromise, reject) => {
    let reading: Readable | null = null;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reading?.destroy();
      // A PassThrough; @types/yazl types it as a plain ReadableStream.
      (zip.outputStream as Readable).destroy();
      out.destroy();
      // The caller deletes the archive next; Windows can't while it is open.
      if (out.closed) reject(error);
      else out.once("close", () => reject(error));
    };
    const onAbort = () => fail(new Error("Request aborted."));
    zip.on("error", fail);
    out.on("error", fail);
    out.on("close", () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    });
    // The client may have left while the archive was being set up.
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    zip.outputStream.pipe(out);
    const run: ZipRun = {
      zip,
      root: realRoot,
      self,
      stopped: () => settled,
      reading: (stream) => (reading = stream),
    };
    addTree(run, "").then(() => {
      if (!settled) zip.end();
    }, fail);
  });
}

/** A path the file routes refuse (outside the workspace, hidden, or not
 *  resolvable); `cause` holds the disk error when resolving it failed. */
export class PathRefusedError extends Error {}

/**
 * Resolve a caller-supplied relative path against `workspaceDir` and guarantee
 * the result stays inside it (no `..` escape, no absolute-path override, no
 * control chars). Returns the absolute, normalized path.
 *
 * `relPath` is treated as relative even if it starts with `/` — a leading slash
 * is stripped so an absolute path can never replace the workspace root.
 */
export function resolveInside(workspaceDir: string, relPath: string): string {
  if (hasControlChar(relPath)) {
    throw new PathRefusedError("Invalid path.");
  }
  // Normalize separators and strip any leading slashes so the path is always
  // interpreted relative to the workspace root.
  const cleaned = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  // Hidden entries (dotfiles like `.langgraph_api`, internal dirs like
  // `large_tool_results`, build noise) are blocked from direct access too — not
  // just unlisted — so a crafted `?path=.langgraph_api` or `?path=large_tool_results`
  // can't read them. `..` is also caught here (and by the boundary check below).
  if (cleaned.split("/").some((seg) => seg !== "" && isHiddenEntry(seg))) {
    throw new PathRefusedError("Path is not accessible.");
  }
  const target = resolve(workspaceDir, cleaned);
  // Must be the workspace dir itself or strictly within it.
  if (target !== workspaceDir && !target.startsWith(workspaceDir + sep)) {
    throw new PathRefusedError("Path is outside the workspace.");
  }
  return target;
}

/**
 * Like `resolveInside`, but ALSO defeats symlink escapes: it canonicalizes the
 * target with `fs.realpath` and re-checks containment + the hidden-entry policy
 * against the real path. A symlink such as `out -> /etc` (so `out/passwd` is
 * lexically "inside") or `link -> .langgraph_api` is rejected here, even though
 * the lexical check in `resolveInside` would pass.
 *
 * `workspaceDir` MUST already be canonical (it is — `projectDir` realpaths
 * it). Throws if the target doesn't exist or escapes. Use this for any access
 * that will then follow the path on disk (stat/read/list).
 */
export async function safeResolve(
  workspaceDir: string,
  relPath: string
): Promise<string> {
  const target = resolveInside(workspaceDir, relPath);
  let realTarget: string;
  try {
    realTarget = await fs.realpath(target);
  } catch (error) {
    // Missing file or a broken/looping symlink — treat as inaccessible. The
    // cause lets the download-all walk tell a gone file from a disk error.
    throw new PathRefusedError("Path is not accessible.", { cause: error });
  }
  if (
    realTarget !== workspaceDir &&
    !realTarget.startsWith(workspaceDir + sep)
  ) {
    throw new PathRefusedError("Path is not accessible.");
  }
  // A symlink could point at a hidden/internal entry that lives inside the
  // workspace (e.g. `foo -> .langgraph_api`); re-check the canonical segments.
  const realRel = relative(workspaceDir, realTarget);
  if (
    realRel &&
    realRel.split(sep).some((seg) => seg !== "" && isHiddenEntry(seg))
  ) {
    throw new PathRefusedError("Path is not accessible.");
  }
  return realTarget;
}

// The machine's own addresses change with Wi-Fi and VPN, so they are re-read
// after a few seconds rather than once at startup.
const ADDRESSES_TTL_MS = 5000;
let addressCache: { at: number; names: Set<string> } | null = null;

/** Test hook: forget the cached interface addresses. */
export function resetMachineAddressCache(): void {
  addressCache = null;
}

/** The IP literals of this machine's interfaces, lowercase, IPv6 without
 *  brackets (Node reports an IPv6 zone in `scopeid`, not in the address). */
function machineAddresses(now: number): Set<string> {
  if (addressCache && now - addressCache.at < ADDRESSES_TTL_MS) {
    return addressCache.names;
  }
  const names = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) names.add(entry.address.toLowerCase());
  }
  addressCache = { at: now, names };
  return names;
}

/** The host name in a `Host` header (`name`, `name:port`, `[v6]:port`),
 *  lowercase, IPv6 without brackets; null when it is malformed. */
export function hostHeaderName(host: string): string | null {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]]+))(?::(\d{1,5}))?$/.exec(host);
  if (!m) return null;
  return (m[1] ?? m[2]).toLowerCase();
}

/**
 * Whether a page may be served on this host name: a loopback name, one of the
 * machine's own IP literals, or the host of an origin in
 * `backend_allowed_origins`, on any port. The same names the backend's browser
 * boundary trusts (langgraph_dev/boundary.py), so a WebUI opened by a name the
 * user allowed for the backend keeps working. A name that DNS rebinding points
 * at this machine is none of these.
 */
export function isTrustedHostName(name: string, now = Date.now()): boolean {
  if (isLoopbackHost(name)) return true;
  if (machineAddresses(now).has(name)) return true;
  return readCoreConfig(now).allowedOrigins.some((origin) => {
    const host = new URL(origin).hostname.toLowerCase();
    return host.replace(/^\[|\]$/g, "") === name;
  });
}

/**
 * Reject cross-site requests to the WebUI's own API routes.
 *
 * - `Host` must name a trusted host (`isTrustedHostName`), which stops DNS
 *   rebinding: a rebinding page sends its own name as `Host`.
 * - `Sec-Fetch-Site`, when present, must be `same-origin` or `none` (a direct
 *   navigation); `same-site` is a page on another port of the same machine.
 * - `Origin`, when present, must equal `Host`. Browsers omit it on same-origin
 *   GETs and on direct navigations (open-in-tab / downloads).
 *
 * Never compare against `nextUrl.origin`: the standalone server derives it
 * from the configured HOSTNAME, not from the address the browser used, so it
 * can never match when binding a wildcard (#35 - with HOSTNAME=0.0.0.0 every
 * write from every page was rejected).
 */
export function isCrossOrigin(request: NextRequest): boolean {
  const host = request.headers.get("host");
  if (!host) {
    return true; // HTTP/1.1 requires Host; only hand-crafted clients omit it
  }
  const name = hostHeaderName(host);
  if (name === null || !isTrustedHostName(name)) {
    return true;
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return true;
  }
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }
  try {
    return new URL(origin).host !== host.toLowerCase();
  } catch {
    return true; // malformed or opaque ("null") Origin - treat as cross-site
  }
}

// ---------------------------------------------------------------------------
// In-place editing (save / delete) of workspace text files
//
// Mirrors the write/delete guards in lib/server/memory.ts. Editing is
// overwrite-only on text/code files: safeResolve requires the target to exist,
// so this path never creates new files (uploads handle creation) and never
// touches a binary. Same-origin enforcement lives in the route.
// ---------------------------------------------------------------------------

/** Text/code extensions editable in place. Superset of the previewable text
 *  types so anything the viewer renders as text can also be saved. Binary
 *  (images/pdf/etc.) is intentionally excluded. */
const EDITABLE_EXTS = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "xml",
  "ini",
  "cfg",
  "conf",
  "env",
  "py",
  "js",
  "jsx",
  "ts",
  "tsx",
  "sh",
  "bash",
  "zsh",
  "r",
  "jl",
  "cpp",
  "cc",
  "c",
  "h",
  "hpp",
  "java",
  "go",
  "rs",
  "rb",
  "php",
  "swift",
  "kt",
  "cs",
  "sql",
  "tex",
  "bib",
  "rst",
  "css",
  "scss",
  "html",
]);

export const MAX_WORKSPACE_WRITE_BYTES = 5 * 1024 * 1024;

/**
 * Re-verify, immediately before a mutating fs op, that the target's parent
 * directory still canonically resolves inside the workspace. `safeResolve`
 * canonicalizes once up front, but a parent component could be swapped for a
 * symlink in the window before the write/rename/rm (TOCTOU). This narrows that
 * window; it cannot fully close it without openat-style fds (not in Node's fs),
 * so a determined local race remains theoretically possible — acceptable for a
 * single-user local dev tool.
 */
async function assertParentInside(
  workspaceDir: string,
  target: string
): Promise<void> {
  let realParent: string;
  try {
    realParent = await fs.realpath(dirname(target));
  } catch {
    throw new Error("Path is not accessible.");
  }
  if (
    realParent !== workspaceDir &&
    !realParent.startsWith(workspaceDir + sep)
  ) {
    throw new Error("Path is not accessible.");
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** True if a file may be edited (and thus saved) as text in the workspace. */
export function isEditableTextFile(name: string): boolean {
  return EDITABLE_EXTS.has(extOf(name));
}

/**
 * Overwrite an existing workspace text file (atomic temp + rename). Preserves
 * the original file's permission bits so the agent's files keep their mode.
 * Rejects binaries, oversized content, and anything that isn't already a file.
 */
export async function writeWorkspaceFile(
  workspaceDir: string,
  relPath: string,
  content: string
): Promise<{ path: string; size: number; mtime: number }> {
  if (typeof content !== "string") throw new Error("Content must be a string.");
  if (Buffer.byteLength(content, "utf-8") > MAX_WORKSPACE_WRITE_BYTES) {
    throw new Error("This file is too large to save.");
  }
  const name = relPath.replaceAll("\\", "/").split("/").pop() || relPath;
  if (!isEditableTextFile(name)) {
    throw new Error("Only text/code files can be edited.");
  }
  // Never edit *through* a final-component symlink: a planted `note.py ->
  // secret.bin` would otherwise let an editable-looking name overwrite a
  // non-editable/binary target inside the workspace. lstat the lexical path so
  // we inspect the link itself, not what it points at.
  const lexical = resolveInside(workspaceDir, relPath);
  let linkStat;
  try {
    linkStat = await fs.lstat(lexical);
  } catch {
    throw new Error("Only files can be edited.");
  }
  if (linkStat.isSymbolicLink()) {
    throw new Error("Editing symlinks is not allowed.");
  }
  // safeResolve canonicalizes + requires existence, so editing is overwrite-only
  // and a symlink can't redirect the write outside the workspace.
  const target = await safeResolve(workspaceDir, relPath);
  // Validate the RESOLVED target's extension too (defends against a parent
  // symlink redirecting the basename), not just the requested name.
  if (!isEditableTextFile(basename(target))) {
    throw new Error("Only text/code files can be edited.");
  }
  const st = await fs.stat(target);
  if (!st.isFile()) throw new Error("Only files can be edited.");

  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await assertParentInside(workspaceDir, target);
    await fs.writeFile(tmp, content, {
      encoding: "utf-8",
      mode: st.mode & 0o777, // keep the original file's permissions
    });
    await assertParentInside(workspaceDir, target);
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }

  const after = await fs.stat(target);
  return {
    path: relPath.replaceAll("\\", "/").replace(/^\/+/, ""),
    size: after.size,
    mtime: after.mtimeMs,
  };
}

/** Permanently delete a workspace file (never a directory). */
export async function deleteWorkspaceFile(
  workspaceDir: string,
  relPath: string
): Promise<void> {
  // safeResolve enforces containment (and rejects a final symlink whose target
  // escapes the workspace). We then act on the LEXICAL path so deleting a
  // symlink unlinks the link itself, not its target — lstat/rm don't follow the
  // final-component symlink.
  await safeResolve(workspaceDir, relPath);
  const lexical = resolveInside(workspaceDir, relPath);
  const st = await fs.lstat(lexical);
  if (st.isDirectory()) throw new Error("Only files can be deleted.");
  // Re-verify the parent is still inside the workspace just before unlinking, to
  // narrow the TOCTOU window after safeResolve (see assertParentInside).
  await assertParentInside(workspaceDir, lexical);
  await fs.rm(lexical, { force: true });
}
