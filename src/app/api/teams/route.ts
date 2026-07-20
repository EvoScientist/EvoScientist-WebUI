import { NextResponse } from "next/server";
import { homedir } from "os";
import { join } from "path";
import { promises as fs } from "fs";

export const runtime = "nodejs";

const DEFAULT_PORT = 6174;
const CONFIG_PATH = join(homedir(), ".config", "evoscientist", "config.yaml");

// Resolve the EvoScientist langgraph dev port the same way the backend does:
// env override > config.yaml > default. Mirrors the identical helper in
// `src/app/api/evosci-config/route.ts` — kept inline (rather than extracted)
// while there are only two server-side proxies; consolidate if a third
// appears. SECURITY: only `langgraph_dev_port` is read from config.yaml;
// API keys and every other field are ignored.
async function resolvePort(): Promise<number> {
  const envPort = process.env.EVOSCIENTIST_LANGGRAPH_DEV_PORT;
  if (envPort && /^\d+$/.test(envPort.trim())) {
    return parseInt(envPort.trim(), 10);
  }
  try {
    const yaml = await fs.readFile(CONFIG_PATH, "utf-8");
    const m = yaml.match(/^\s*langgraph_dev_port:\s*(\d+)\s*$/m);
    if (m) return parseInt(m[1], 10);
  } catch {
    // No config file — fall through to the default.
  }
  return DEFAULT_PORT;
}

// Proxy the backend's `/api/teams` endpoint (registered in
// `EvoScientist/langgraph_dev/http.py` from Phase 3 of the agent-teams
// design plan). Response shape is echoed verbatim:
// `{ "teams": [{name, description, byline?, capability_tags?, avatar_hint?}] }`,
// matching the WebUI's `Team` type in `src/lib/teams.ts`.
//
// The upstream is the local langgraph dev deployment (loopback only); we
// forward as-is rather than transforming so a backend schema evolution
// surfaces at the consumer (`useTeams` -> `ExpertsPanel`) rather than being
// silently rewritten here.
export async function GET() {
  const port = await resolvePort();
  const upstreamUrl = `http://127.0.0.1:${port}/api/teams`;
  try {
    const upstream = await fetch(upstreamUrl, { cache: "no-store" });
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Backend /api/teams returned ${upstream.status}` },
        { status: 502 }
      );
    }
    const body = await upstream.json();
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : "Failed to reach backend /api/teams",
      },
      { status: 502 }
    );
  }
}
