import { join } from "path";
import { type NextRequest, NextResponse } from "next/server";
import { listPinnableSkills, SKILLS_INSTALL_DIR } from "@/lib/server/skills";
import { getWorkspaceDir, isCrossOrigin } from "@/lib/server/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

/** The skills the composer's `/` menu offers: the ones the backend can pin. */
export async function GET(request: NextRequest) {
  if (isCrossOrigin(request)) {
    return NextResponse.json(
      { error: "Cross-origin access not allowed." },
      { status: 403, headers: NO_STORE_HEADERS }
    );
  }
  // No backend running means no workspace: the global tier alone.
  const workspace = await getWorkspaceDir().then(
    (dir) => join(dir, "skills"),
    () => null
  );
  try {
    const skills = await listPinnableSkills({
      workspace,
      global: SKILLS_INSTALL_DIR,
    });
    return NextResponse.json({ skills }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to read skills.",
      },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
