// What the status page shows: progress while the app starts, or an error with
// its code, its own text and the actions that can fix it. Most `deploy` codes
// come from the configuration or the machine, so Retry alone does not fix
// them, and the settings page that could needs a running backend.
import type { BootError, BootState } from "./boot";

export type ActionId =
  | "retry"
  | "restart_ui"
  | "set_port"
  | "choose_folder"
  | "copy_command"
  | "open_logs"
  | "open_config"
  | "open_crash"
  | "quit";

export interface ProgressScreen {
  kind: "progress";
  title: string;
  message: string;
}

export interface ErrorScreen {
  kind: "error";
  code: string;
  title: string;
  /** Paragraphs, in order. */
  lines: string[];
  /** A command to run in a terminal, shown with "Copy". */
  command?: string;
  actions: ActionId[];
  /** The port shown in the "another port" field. */
  port?: number;
  logFolder: string;
  crashReport?: string;
}

export type Screen = ProgressScreen | ErrorScreen;

export function progressScreen(
  state: BootState | "starting_ui" | "stopping"
): ProgressScreen {
  const s = typeof state === "string" ? state : state.phase;
  const text: Record<string, [string, string]> = {
    checking_core: [
      "Starting EvoScientist",
      "Checking the installed EvoScientist...",
    ],
    preparing_node: [
      "Starting EvoScientist",
      "Preparing Node for the agent's tools...",
    ],
    starting_backend: ["Starting EvoScientist", "Starting the backend..."],
    ready: ["Starting EvoScientist", "Starting the WebUI..."],
    starting_ui: ["Starting EvoScientist", "Starting the WebUI..."],
    stopping: ["Restarting the backend", "Stopping the backend..."],
  };
  const [title, message] = text[s] ?? ["Starting EvoScientist", ""];
  if (typeof state !== "string" && state.phase === "starting_backend")
    return {
      kind: "progress",
      title,
      message: `Starting the backend for ${state.workspace}...`,
    };
  return { kind: "progress", title, message };
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

export interface ScreenContext {
  platform: NodeJS.Platform;
  /** The backend port the app read from config.yaml or its environment. */
  port: number;
  logFolder: string;
  crashReport: string | null;
}

export function errorScreen(error: BootError, ctx: ScreenContext): ErrorScreen {
  const d = error.detail ?? {};
  const terminal = ctx.platform === "win32" ? "PowerShell" : "a terminal";
  const base = {
    kind: "error" as const,
    code: error.code,
    logFolder: ctx.logFolder,
  };
  const hint = str(d.hint);
  let screen: Omit<ErrorScreen, "kind" | "code" | "logFolder">;

  switch (error.code) {
    case "core_missing":
      screen = {
        title: "EvoScientist is not installed",
        lines: [
          error.message,
          `Install it with this command in ${terminal}, then press Retry.`,
        ],
        command: str(d.install_command) ?? undefined,
        actions: ["retry", "copy_command", "open_logs"],
      };
      break;
    case "core_too_old":
      screen = {
        title: "EvoScientist needs an update",
        lines: [
          error.message,
          `Install the current release with this command in ${terminal}, then press Retry.`,
        ],
        command: str(d.install_command) ?? undefined,
        actions: ["retry", "copy_command"],
      };
      break;
    case "core_too_new":
    case "webui_incompatible":
    case "unknown_protocol":
      screen = {
        title: "This app needs an update",
        lines: [error.message, "Install the newest EvoScientist desktop app."],
        actions: ["retry", "open_logs"],
      };
      break;
    case "version_check_timeout":
      screen = {
        title: "EvoScientist did not answer",
        lines: [
          error.message,
          "A first start after an install can be slow. Press Retry.",
        ],
        actions: ["retry", "open_logs"],
      };
      break;
    case "workspace_unavailable":
      screen = {
        title: "The workspace folder is not available",
        lines: [
          error.message,
          "Choose another folder for your work. The app saves it as default_workdir and starts there from now on.",
        ],
        actions: ["choose_folder", "retry", "open_config"],
      };
      break;
    case "port_conflict": {
      const foreign = d.reason === "foreign";
      screen = foreign
        ? {
            title: `Port ${ctx.port} is in use`,
            lines: [
              `Another program uses port ${ctx.port}, the backend's port.`,
              "Choose another port. The app saves it as langgraph_dev_port and starts the backend there.",
            ],
            actions: ["set_port", "retry", "open_logs"],
            port: ctx.port + 1,
          }
        : {
            title: `Another EvoScientist backend uses port ${ctx.port}`,
            lines: [
              ...(hint ? [hint] : [error.message]),
              "Stop it, then press Retry.",
            ],
            actions: ["retry", "open_logs"],
          };
      break;
    }
    case "invalid_port":
      screen = {
        title: "The backend port is not valid",
        lines: [
          error.message,
          "Choose another port. The app saves it as langgraph_dev_port.",
        ],
        actions: ["set_port", "retry", "open_config"],
        port: 6174,
      };
      break;
    case "workspace_conflict": {
      const other = str(d.run_dir) ?? str(d.workspace);
      screen = {
        title: "A backend for another folder is running",
        lines: [
          other ? `It serves ${other}.` : error.message,
          "The app never starts a second backend. Stop the other one, then press Retry.",
        ],
        actions: ["retry", "open_logs"],
      };
      break;
    }
    case "sign_in_required":
      screen = {
        title: `Sign in${str(d.provider) ? ` to ${d.provider}` : ""}`,
        lines: [
          error.message,
          `Sign in with this command in ${terminal}, then press Retry.`,
        ],
        command: "EvoSci onboard",
        actions: ["retry", "copy_command"],
      };
      break;
    case "backend_exited":
      screen = {
        title: "The backend stopped",
        lines: [error.message, "Press Retry to start it again."],
        actions: ["retry", "open_logs"],
      };
      break;
    case "ui_server_exited":
      screen = {
        title: "The WebUI server stopped",
        lines: [
          error.message,
          "Press Retry to start it again. The backend keeps running.",
        ],
        actions: ["restart_ui", "open_logs"],
      };
      break;
    default:
      // ccproxy_failed, backend_start_failed, internal_error and anything new.
      screen = {
        title: "EvoScientist could not start",
        lines: [error.message],
        actions: ["retry", "open_logs", "open_config"],
      };
  }
  return {
    ...base,
    ...screen,
    ...(ctx.crashReport
      ? {
          crashReport: ctx.crashReport,
          actions: [...screen.actions, "open_crash" as const],
        }
      : {}),
  };
}
