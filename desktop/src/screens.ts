// What the status page shows: progress while the app starts (with the install
// script's last lines, or setup's stages), the mirror question on a first
// install, or an error with its code, its own text and the actions that can
// fix it. Most `deploy` codes
// come from the configuration or the machine, so Retry alone does not fix
// them, and the settings page that could needs a running backend.
import type { BootError, BootState } from "./boot";
import { DEFAULT_BACKEND_PORT } from "./paths";
import type { Stage } from "./setup";

export type ActionId =
  | "retry"
  | "restart_ui"
  | "set_port"
  | "choose_folder"
  | "copy_command"
  | "open_logs"
  | "open_config"
  | "open_crash"
  | "quit"
  | "mirror_cn"
  | "mirror_default"
  | "retry_cn"
  | "continue";

export interface ProgressScreen {
  kind: "progress";
  title: string;
  message: string;
}

/** A question with one button per answer (the mirror question). */
export interface QuestionScreen {
  kind: "question";
  title: string;
  lines: string[];
  actions: ActionId[];
}

/** The install script runs: its last lines as they come. */
export interface InstallScreen {
  kind: "install";
  title: string;
  message: string;
  output: string[];
}

/** `EvoSci setup` runs: each stage with its state. */
export interface SetupScreen {
  kind: "setup";
  title: string;
  stages: Stage[];
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
  /** The install script's output from its last `Error:` line. */
  output?: string[];
  /** Setup's failed stages. */
  stages?: Stage[];
}

export type Screen =
  | ProgressScreen
  | QuestionScreen
  | InstallScreen
  | SetupScreen
  | ErrorScreen;

/** Shown next to "Retry with mainland China mirrors": the choice stays. */
const MIRROR_RETRY_LINE =
  "Retry with mainland China mirrors keeps using them while the app runs, and setup saves them for later launches; the settings page can change it.";

/** The first-launch question, before the install script runs (D15). */
export function mirrorQuestion(): QuestionScreen {
  return {
    kind: "question",
    title: "Install EvoScientist",
    lines: [
      "EvoScientist is not installed yet. The app installs it now, with Python and the packages it needs.",
      "Are you in mainland China? Then the downloads use mirrors there (Tsinghua PyPI, npmmirror), which are faster and reachable behind the firewall. The app remembers the answer; the settings page can change it later.",
    ],
    actions: ["mirror_default", "mirror_cn"],
  };
}

/** The install script's progress: the last lines of its output. */
export function installScreen(state: {
  repair: boolean;
  lines: string[];
}): InstallScreen {
  return {
    kind: "install",
    title: state.repair ? "Repairing EvoScientist" : "Installing EvoScientist",
    message: state.repair
      ? "The installed EvoScientist does not run. Installing it again; your settings are kept."
      : "Downloading and installing EvoScientist. This takes a few minutes.",
    output: state.lines,
  };
}

/** Setup's progress: every stage with its state. */
export function setupScreen(stages: Stage[]): SetupScreen {
  return { kind: "setup", title: "Setting up EvoScientist", stages };
}

/** The progress screen for a launch phase, the UI start or a stop. */
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
    update_finishing: [
      "An update of EvoScientist is finishing",
      "The app waits until it is done, then goes on.",
    ],
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

/** The value when it is a non-empty string. */
const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

export interface ScreenContext {
  platform: NodeJS.Platform;
  /** The backend port the app read from config.yaml or its environment. */
  port: number;
  logFolder: string;
  crashReport: string | null;
  /** `EVOSCIENTIST_LANGGRAPH_DEV_PORT` / `EVOSCIENTIST_WORKSPACE_DIR` are set:
   *  they win over what the app saves, so the screen offers no choice. */
  portFromEnv?: boolean;
  workspaceFromEnv?: boolean;
}

const ENV_PORT_LINE =
  "EVOSCIENTIST_LANGGRAPH_DEV_PORT is set in the app's environment and wins over a saved port. Change or remove it, restart the app, then press Retry.";
const ENV_WORKSPACE_LINE =
  "EVOSCIENTIST_WORKSPACE_DIR is set in the app's environment and wins over a saved folder. Change or remove it, restart the app, then press Retry.";

/** The error screen for a code: its own text and the actions that can fix it. */
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
    case "install_failed": {
      const output = Array.isArray(d.output) ? (d.output as string[]) : [];
      screen = {
        title: d.repair
          ? "EvoScientist could not be repaired"
          : "EvoScientist could not be installed",
        lines: [
          error.message,
          d.running
            ? "EvoScientist is running. Close the programs listed below, then press Retry."
            : "Press Retry to run the install again.",
          ...(d.cn ? [] : [MIRROR_RETRY_LINE]),
        ],
        ...(output.length > 0 ? { output } : {}),
        actions: d.cn
          ? ["retry", "open_logs"]
          : ["retry", "retry_cn", "open_logs"],
      };
      break;
    }
    case "unsupported_platform":
      screen = {
        title: "This computer is not supported yet",
        lines: [error.message, "Nothing was installed."],
        actions: ["open_logs"],
      };
      break;
    case "setup_failed": {
      const failed = Array.isArray(d.failed)
        ? (d.failed as {
            id: string;
            title: string;
            code: string | null;
            message: string | null;
          }[])
        : [];
      screen = {
        title: "Some setup steps failed",
        lines: [
          error.message,
          "Retry runs setup again. Continue starts EvoScientist without these steps (only the Node step runs); the next launch runs setup again.",
          ...(d.cn ? [] : [MIRROR_RETRY_LINE]),
        ],
        stages: failed.map((f) => ({
          id: f.id,
          title: f.title,
          state: "error" as const,
          ...(f.code ? { code: f.code } : {}),
          ...(f.message ? { message: f.message } : {}),
        })),
        actions: d.cn
          ? ["retry", "continue", "open_logs"]
          : ["retry", "retry_cn", "continue", "open_logs"],
      };
      break;
    }
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
          ctx.workspaceFromEnv
            ? ENV_WORKSPACE_LINE
            : "Choose another folder for your work. The app saves it as default_workdir and starts there from now on.",
        ],
        actions: ctx.workspaceFromEnv
          ? ["retry", "open_config"]
          : ["choose_folder", "retry", "open_config"],
      };
      break;
    case "port_conflict": {
      const foreign = d.reason === "foreign";
      screen = foreign
        ? {
            title: `Port ${ctx.port} is in use`,
            lines: [
              `Another program uses port ${ctx.port}, the backend's port.`,
              ctx.portFromEnv
                ? ENV_PORT_LINE
                : "Choose another port. The app saves it as langgraph_dev_port and starts the backend there.",
            ],
            actions: ctx.portFromEnv
              ? ["retry", "open_logs"]
              : ["set_port", "retry", "open_logs"],
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
          ctx.portFromEnv
            ? ENV_PORT_LINE
            : "Choose another port. The app saves it as langgraph_dev_port.",
        ],
        actions: ctx.portFromEnv
          ? ["retry", "open_config"]
          : ["set_port", "retry", "open_config"],
        port: DEFAULT_BACKEND_PORT,
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
