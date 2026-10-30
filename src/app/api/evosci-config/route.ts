import { NextResponse } from "next/server";
import { readCoreConfig } from "@/lib/server/coreConfig";

// The EvoScientist backend's port: env override > the port the running
// backend recorded > config.yaml > default. SECURITY: only the port is returned;
// see coreConfig.ts for what is read from config.yaml.
export async function GET() {
  const { port } = readCoreConfig();
  return NextResponse.json({
    port,
    deploymentUrl: `http://127.0.0.1:${port}`,
  });
}
