import { describe, expect, it } from "vitest";
import {
  errorScreen,
  installScreen,
  mirrorQuestion,
  progressScreen,
  separateInstallQuestion,
  setupScreen,
  updateQuestion,
  updateScreen,
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
  it("shows the install command for a core that is not a release", () => {
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
    // The mirror retry says that the choice stays, and only where offered.
    expect(off.lines.join(" ")).toMatch(/keeps using them while the app runs/);
    expect(on.lines.join(" ")).not.toMatch(/keeps using them/);
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
    expect(s.lines.join(" ")).toMatch(/only the Node step runs/);
    expect(s.lines.join(" ")).toMatch(/keeps using them while the app runs/);
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

describe("core update screens (W03c)", () => {
  const view = {
    update: { progress: 0.25, message: "Update pending" },
    stages: [{ id: "node", title: "Node.js", state: "pending" as const }],
    waiting: null,
  };
  const python = [{ pid: 7, name: "python", path: "C:\\env\\python.exe" }];

  it("the offer names the version and the range, with Update and Quit", () => {
    expect(updateQuestion("0.3.7", ">=0.3.8,<0.4")).toMatchObject({
      kind: "question",
      title: "Update EvoScientist",
      lines: [
        "The installed EvoScientist 0.3.7 is older than this app supports (>=0.3.8,<0.4).",
        expect.stringContaining("needs a network"),
      ],
      actions: ["update", "quit"],
    });
  });

  it("the separate-install question shows the core's message", () => {
    const q = separateInstallQuestion("Installed with pip.", "0.3.7");
    expect(q.lines[0]).toBe("Installed with pip.");
    expect(q.lines[1]).toContain(
      "Your EvoScientist 0.3.7 from pip or conda stays as it is"
    );
    expect(q.actions).toEqual(["install_copy", "quit"]);
  });

  it("the update's row comes first, then the setup stages", () => {
    expect(updateScreen(view)).toEqual({
      kind: "setup",
      title: "Updating EvoScientist",
      stages: [
        {
          id: "update",
          title: "Update EvoScientist",
          state: "running",
          progress: 0.25,
          message: "Update pending",
        },
        { id: "node", title: "Node.js", state: "pending" },
      ],
    });
    expect(updateScreen({ ...view, update: {} }).stages[0]).toEqual({
      id: "update",
      title: "Update EvoScientist",
      state: "running",
    });
  });

  it("while it waits: the processes and Cancel; while quitting: no Cancel", () => {
    const w = updateScreen({ ...view, waiting: python });
    expect(w.lines).toEqual([
      "The update waits until these programs, which run EvoScientist, are closed:",
      "python (7): C:\\env\\python.exe",
      "Close them and the update goes on. Cancel stops the update; nothing is changed.",
    ]);
    expect(w.actions).toEqual(["cancel_update"]);
    const q = updateScreen({ ...view, waiting: python }, true);
    expect(q.title).toBe("Finishing the update");
    expect(q.actions).toBeUndefined();
    expect(q.lines?.at(-1)).toBe(
      "The app cancels the update and quits; nothing is changed."
    );
    expect(updateScreen(view, true)).toMatchObject({
      title: "Finishing the update",
      lines: ["The app quits when the update is done."],
    });
  });

  it("the script as an update has its own title", () => {
    expect(
      installScreen({ repair: true, update: true, lines: [] })
    ).toMatchObject({
      title: "Updating EvoScientist",
    });
  });

  it("release_lookup_failed asks for a network, with Retry", () => {
    expect(errorScreen(err("release_lookup_failed"), ctx)).toMatchObject({
      title: "Updating EvoScientist needs a network",
      actions: ["retry", "open_logs"],
    });
  });

  it("server_running asks to stop the terminal's backend, with the core's message when there is one", () => {
    const s = errorScreen(
      err("server_running", { port: 6174, core_message: "kill it" }),
      ctx
    );
    expect(s.lines).toEqual([
      "Stop the backend started in the terminal, then press Retry.",
      "kill it",
    ]);
    expect(s.actions).toEqual(["retry", "open_logs"]);
    expect(errorScreen(err("server_running"), ctx).lines).toHaveLength(1);
  });

  it("environment_busy names what still runs", () => {
    const s = errorScreen(
      err("environment_busy", { waiting_for: python }),
      ctx
    );
    expect(s.title).toBe("The update was cancelled");
    expect(s.lines).toContain("Still running: python (7).");
    expect(errorScreen(err("environment_busy"), ctx).lines).toHaveLength(2);
  });

  it("manual_update and update_failed", () => {
    expect(errorScreen(err("manual_update"), ctx)).toMatchObject({
      title: "EvoScientist cannot be updated from the app",
      lines: ["manual_update message", expect.any(String)],
    });
    expect(errorScreen(err("update_failed"), ctx).title).toBe(
      "The update did not finish"
    );
  });

  it("install and setup failures after an update say so", () => {
    expect(
      errorScreen(err("install_failed", { repair: true, update: true }), ctx)
        .title
    ).toBe("EvoScientist could not be updated");
    expect(errorScreen(err("setup_failed", { update: true }), ctx).title).toBe(
      "EvoScientist was updated, but some setup steps failed"
    );
  });
});
