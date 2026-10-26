import { describe, expect, it } from "vitest";
import {
  errorScreen,
  installScreen,
  mirrorQuestion,
  progressScreen,
  setupScreen,
} from "./screens";

const ctx = {
  platform: "win32" as const,
  port: 6174,
  logFolder: "C:\\logs",
  crashReport: null,
};
const err = (code: string, detail: Record<string, unknown> = {}) => ({
  code,
  message: `${code} message`,
  detail,
});

describe("errorScreen", () => {
  it("shows the install command for an old core (until W03c)", () => {
    const s = errorScreen(
      err("core_too_old", { install_command: "irm x | iex" }),
      ctx
    );
    expect(s.command).toBe("irm x | iex");
    expect(s.actions).toEqual(
      expect.arrayContaining(["retry", "copy_command"])
    );
  });

  it("shows a failed install's output, and mirrors only while they are off", () => {
    const output = ["Error: Cannot download x", "more"];
    const off = errorScreen(err("install_failed", { output, cn: false }), ctx);
    expect(off).toMatchObject({
      title: "EvoScientist could not be installed",
      output,
      actions: ["retry", "retry_cn", "open_logs"],
    });
    const on = errorScreen(
      err("install_failed", { output, cn: true, repair: true }),
      ctx
    );
    expect(on.title).toBe("EvoScientist could not be repaired");
    expect(on.actions).toEqual(["retry", "open_logs"]);
  });

  it("says to close the running programs when the script refused", () => {
    const s = errorScreen(
      err("install_failed", {
        output: ["Error: EvoScientist is running"],
        running: true,
      }),
      ctx
    );
    expect(s.lines[1]).toMatch(
      /Close the programs listed below, then press Retry/
    );
  });

  it("lists the failed setup steps with Retry and Continue", () => {
    const s = errorScreen(
      err("setup_failed", {
        cn: false,
        failed: [
          {
            id: "node",
            title: "Node.js",
            code: "download_failed",
            message: "blocked",
          },
        ],
      }),
      ctx
    );
    expect(s.stages).toEqual([
      {
        id: "node",
        title: "Node.js",
        state: "error",
        code: "download_failed",
        message: "blocked",
      },
    ]);
    expect(s.actions).toEqual(["retry", "retry_cn", "continue", "open_logs"]);
  });

  it("has nothing to retry on an unsupported platform", () => {
    const s = errorScreen(err("unsupported_platform"), ctx);
    expect(s.actions).toEqual(["open_logs"]);
    expect(s.lines).toContain("Nothing was installed.");
  });

  it("asks to update the app for a newer core, an unknown protocol or a refused UI", () => {
    for (const code of [
      "core_too_new",
      "webui_incompatible",
      "unknown_protocol",
    ])
      expect(errorScreen(err(code), ctx).title).toBe(
        "This app needs an update"
      );
  });

  it("offers another port when another program holds it", () => {
    const s = errorScreen(err("port_conflict", { reason: "foreign" }), ctx);
    expect(s.title).toBe("Port 6174 is in use");
    expect(s.actions).toContain("set_port");
    expect(s.port).toBe(6175);
    expect(
      errorScreen(err("invalid_port", { port: 0 }), ctx).actions
    ).toContain("set_port");
  });

  it("offers no port or folder choice when an environment variable wins", () => {
    const env = { ...ctx, portFromEnv: true, workspaceFromEnv: true };
    for (const e of [
      err("port_conflict", { reason: "foreign" }),
      err("invalid_port", { port: 0 }),
    ]) {
      const s = errorScreen(e, env);
      expect(s.actions).not.toContain("set_port");
      expect(s.lines.join(" ")).toContain("EVOSCIENTIST_LANGGRAPH_DEV_PORT");
    }
    const w = errorScreen(err("workspace_unavailable"), env);
    expect(w.actions).not.toContain("choose_folder");
    expect(w.lines.join(" ")).toContain("EVOSCIENTIST_WORKSPACE_DIR");
    expect(errorScreen(err("workspace_unavailable"), ctx).actions).toContain(
      "choose_folder"
    );
  });

  it("says to stop another EvoScientist backend on the port", () => {
    for (const reason of ["no_record", "record_mismatch"]) {
      const s = errorScreen(
        err("port_conflict", {
          reason,
          hint: "Stop it with EvoSci server stop",
        }),
        ctx
      );
      expect(s.title).toBe("Another EvoScientist backend uses port 6174");
      expect(s.lines).toEqual([
        "Stop it with EvoSci server stop",
        "Stop it, then press Retry.",
      ]);
      expect(s.actions).not.toContain("set_port");
    }
  });

  it("names the other folder of a workspace conflict", () => {
    const s = errorScreen(
      err("workspace_conflict", { workspace: "D:\\other" }),
      ctx
    );
    expect(s.lines[0]).toBe("It serves D:\\other.");
    expect(s.actions).toEqual(["retry", "open_logs"]);
  });

  it("gives sign_in_required, start failures and the workspace their own actions", () => {
    expect(
      errorScreen(err("sign_in_required", { provider: "openai" }), ctx)
    ).toMatchObject({
      title: "Sign in to openai",
      command: "EvoSci onboard",
    });
    for (const code of [
      "ccproxy_failed",
      "backend_start_failed",
      "internal_error",
    ])
      expect(errorScreen(err(code), ctx).actions).toEqual([
        "retry",
        "open_logs",
        "open_config",
      ]);
    expect(errorScreen(err("workspace_unavailable"), ctx).actions[0]).toBe(
      "choose_folder"
    );
  });

  it("restarts only the UI server after it exited", () => {
    expect(errorScreen(err("ui_server_exited"), ctx).actions).toEqual([
      "restart_ui",
      "open_logs",
    ]);
    expect(errorScreen(err("backend_exited"), ctx).actions[0]).toBe("retry");
  });

  it("adds the crash report and its folder", () => {
    const s = errorScreen(err("internal_error"), {
      ...ctx,
      crashReport: "C:\\logs\\desktop-crash-1.txt",
    });
    expect(s.crashReport).toBe("C:\\logs\\desktop-crash-1.txt");
    expect(s.actions).toContain("open_crash");
  });
});

describe("first-launch screens", () => {
  it("asks about mirrors with one button per answer", () => {
    expect(mirrorQuestion()).toMatchObject({
      kind: "question",
      actions: ["mirror_default", "mirror_cn"],
    });
  });

  it("shows the install output, and setup's stages", () => {
    expect(installScreen({ repair: true, lines: ["a"] })).toMatchObject({
      kind: "install",
      title: "Repairing EvoScientist",
      output: ["a"],
    });
    const stages = [
      { id: "node", title: "Node.js", state: "running" as const },
    ];
    expect(setupScreen(stages)).toEqual({
      kind: "setup",
      title: "Setting up EvoScientist",
      stages,
    });
  });

  it("names an update that is finishing", () => {
    expect(progressScreen({ phase: "update_finishing" }).title).toBe(
      "An update of EvoScientist is finishing"
    );
  });
});
