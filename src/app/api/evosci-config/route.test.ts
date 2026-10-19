import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GET } from "./route";
import { resetCoreConfigCache } from "@/lib/server/coreConfig";

let xdg: string;

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "evo-xdg-"));
  vi.stubEnv("XDG_CONFIG_HOME", xdg);
  vi.stubEnv("EVOSCIENTIST_LANGGRAPH_DEV_PORT", "");
  resetCoreConfigCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(xdg, { recursive: true, force: true });
});

describe("GET /api/evosci-config", () => {
  it("reads langgraph_dev_port from $XDG_CONFIG_HOME and returns no other field", async () => {
    mkdirSync(join(xdg, "evoscientist"));
    writeFileSync(
      join(xdg, "evoscientist", "config.yaml"),
      "langgraph_dev_port: 7010\nopenai_api_key: sk-secret\nbackend_allowed_origins: http://box.lan\n"
    );
    const res = await GET();
    expect(await res.json()).toEqual({
      port: 7010,
      deploymentUrl: "http://127.0.0.1:7010",
    });
  });
});
