import { createReadStream } from "fs";
import { promises as fs } from "fs";
import { basename, extname } from "path";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import {
  getWorkspaceDir,
  safeResolve,
  isCrossOrigin,
} from "@/lib/server/workspace";

/** RFC 6266 Content-Disposition value with both an ASCII fallback and a UTF-8
 *  `filename*` so non-ASCII names (e.g. Chinese) download with their real name
 *  instead of percent-encoded gibberish. */
function contentDisposition(fileName: string, asAttachment: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `${
    asAttachment ? "attachment" : "inline"
  }; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export const runtime = "nodejs";

// Map common research-output extensions to a Content-Type. Anything unlisted is
// served as a download (octet-stream) so the browser never tries to execute it.
const CONTENT_TYPES: Record<string, string> = {
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  log: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  json: "application/json; charset=utf-8",
  py: "text/plain; charset=utf-8",
  js: "text/plain; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  tsx: "text/plain; charset=utf-8",
  sh: "text/plain; charset=utf-8",
  yaml: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8",
  toml: "text/plain; charset=utf-8",
  tex: "text/plain; charset=utf-8",
  bib: "text/plain; charset=utf-8",
  html: "text/plain; charset=utf-8", // never text/html — don't let it render
  css: "text/plain; charset=utf-8",
  xml: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  pdf: "application/pdf",
};

export async function GET(request: NextRequest) {
  try {
    if (isCrossOrigin(request)) {
      return NextResponse.json(
        { error: "Cross-origin workspace access is not allowed." },
        { status: 403 }
      );
    }

    const relPath = request.nextUrl.searchParams.get("path");
    if (!relPath) {
      return NextResponse.json({ error: "Missing path." }, { status: 400 });
    }
    const download = request.nextUrl.searchParams.get("download") === "1";

    const workspaceDir = await getWorkspaceDir();
    // safeResolve canonicalizes + re-checks containment, so a symlink can't be
    // used to read a file outside the workspace (or a hidden/internal entry).
    const target = await safeResolve(workspaceDir, relPath);

    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Not a file." }, { status: 400 });
    }

    const ext = extname(target).slice(1).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
    // Octet-stream and explicit ?download=1 go out as attachments; previewable
    // types render inline.
    const asAttachment = download || contentType === "application/octet-stream";

    const nodeStream = createReadStream(target);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

    const fileName = basename(target);
    return new NextResponse(webStream, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
        "Content-Disposition": contentDisposition(fileName, asAttachment),
        // Workspace files are agent/user-controlled. `sandbox` neutralizes
        // scripts in an inline SVG/HTML opened directly (XSS), and `nosniff`
        // stops the browser from sniffing a text/* file into executable HTML.
        // Neither affects <img>/<iframe> preview rendering in the UI.
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
        // The path uniquely identifies a one-shot fetch; never cache stale agent output.
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to read file.",
      },
      { status: 400 }
    );
  }
}
