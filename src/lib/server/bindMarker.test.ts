import { readFileSync } from "fs";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";
import {
  BIND_MARKER,
  markStandaloneServer,
} from "../../../scripts/bind-marker.mjs";
import { BIND_MARKER as GATE_MARKER } from "@/lib/server/settingsRelay";

const server = "const hostname = process.env.HOSTNAME || '0.0.0.0'\n";

describe("bind marker", () => {
  it("is the name the settings gate reads", () => {
    expect(BIND_MARKER).toBe(GATE_MARKER);
  });

  it("sets the marker at the top of the standalone server, once", () => {
    const marked = markStandaloneServer(server);
    expect(marked).toBe(
      `process.env.EVOSCIENTIST_WEBUI_BINDS_HOSTNAME = "1"\n${server}`
    );
    expect(markStandaloneServer(marked)).toBe(marked);
  });

  it("fails the build when the server no longer binds HOSTNAME", () => {
    expect(() => markStandaloneServer("const hostname = '0.0.0.0'\n")).toThrow(
      /no longer binds/
    );
  });

  it("matches the server Next.js writes in this version", () => {
    // next build copies this template into .next/standalone/server.js.
    const require = createRequire(import.meta.url);
    const template = readFileSync(
      require.resolve("next/dist/build/utils.js"),
      "utf8"
    );
    expect(template).toMatch(/const hostname = process\.env\.HOSTNAME\b/);
  });
});
