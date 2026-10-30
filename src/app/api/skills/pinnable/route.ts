import { join } from "path";
import { type NextRequest, NextResponse } from "next/server";
import { listPinnableSkills, SKILLS_INSTALL_DIR } from "@/lib/server/skills";
import { projectDir } from "@/lib/server/projects";
import { isCrossOrigin } from "@/lib/server/workspace";

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
  // The project's skills too when the request names a project this
  // machine's backend serves (`?project=`); the global tier alone otherwise.
  const workspace = await projectDir(request).then(
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
