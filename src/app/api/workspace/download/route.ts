import { createReadStream, promises as fs } from "fs";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import {
  getWorkspaceDir,
  isCrossOrigin,
  workspaceArchivePath,
  zipWorkspace,
} from "@/lib/server/workspace";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  let tmpFile: string | null = null;
  try {
    if (isCrossOrigin(request)) {
      return NextResponse.json(
        { error: "Cross-origin workspace access is not allowed." },
        { status: 403 }
      );
    }

    const workspaceDir = await getWorkspaceDir();
    tmpFile = workspaceArchivePath();
    await zipWorkspace(workspaceDir, tmpFile, request.signal);

    const stat = await fs.stat(tmpFile);
    const nodeStream = createReadStream(tmpFile);
    // Delete the temp archive once the response has been fully read (or the
    // client disconnects) — `close` fires in both cases.
    const cleanup = tmpFile;
    nodeStream.on("close", () => {
      fs.rm(cleanup, { force: true }).catch(() => {});
    });
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

    return new NextResponse(webStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(stat.size),
        "Content-Disposition": 'attachment; filename="workspace.zip"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (tmpFile) await fs.rm(tmpFile, { force: true }).catch(() => {});
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to package the workspace.",
      },
      { status: 400 }
    );
  }
}
