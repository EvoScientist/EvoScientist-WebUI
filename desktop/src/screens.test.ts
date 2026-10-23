import { describe, expect, it } from "vitest";
import { errorScreen } from "./screens";

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
  it("shows the install command for a missing or old core", () => {
    for (const code of ["core_missing", "core_too_old"]) {
      const s = errorScreen(err(code, { install_command: "irm x | iex" }), ctx);
      expect(s.command).toBe("irm x | iex");
      expect(s.actions).toEqual(
        expect.arrayContaining(["retry", "copy_command"])
      );
    }
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
