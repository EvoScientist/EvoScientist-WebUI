// macOS: whether a process has an icon of its own in the Dock, as
// LaunchServices lists it (`lsappinfo`). The smoke test asks for the UI
// server, which must have none.
import { execFileSync, spawn } from "node:child_process";

/** The list of applications, or null when it cannot be read. */
function appList(timeoutMs) {
  try {
    return execFileSync("/usr/bin/lsappinfo", ["list"], {
      encoding: "utf8",
      timeout: timeoutMs,
    });
  } catch {
    return null;
  }
}

/** The entry of `pid` in `list`, or undefined. One entry per application:
 *  `<n>) "<name>" ASN:...`, then indented lines, one of them
 *  `pid = <pid> ... type="Foreground"` (or "UIElement", "BackgroundOnly"). */
function entryOf(list, pid) {
  return list
    .split(/\n(?=\s*\d+\) ")/)
    .find((e) => new RegExp(`^\\s*pid = ${pid}\\b`, "m").test(e));
}

/** Whether an entry is a foreground application: those have a Dock icon. */
const isForeground = (entry) => /\btype="Foreground"/.test(entry);

/**
 * Whether `pid` has a Dock icon: `{ shown }`, read from a list that is known
 * to show Dock icons and that has `pid` in it, or `{ unseen: <why> }` when no
 * such list was read within `timeoutMs`. A process that is in no list (it
 * has ended, or never registered with macOS) is unseen, not "without icon".
 *
 * The control: a process of `controlExe` (an app's own executable) in Node
 * mode that sets its process title gets a Dock icon, so the list must have
 * it as a foreground application, and `pid` is looked up in that same list.
 * Where the control is not listed (no login session with a Dock, no list)
 * every process would read as "no icon", and a check built on that would
 * pass without having seen anything.
 */
export async function dockIconOf(pid, controlExe, timeoutMs = 15_000) {
  // Nothing to look up: it would read as "no icon".
  if (!Number.isInteger(pid)) return { unseen: "there is no process id" };
  // Left alone (this script was ended), the control ends by itself.
  const holdMs = timeoutMs + 15_000;
  const control = spawn(
    controlExe,
    ["-e", `process.title = 'dock-control'; setTimeout(() => {}, ${holdMs})`],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore" }
  );
  control.on("error", () => {});
  // No signal for a control that could not be started: until Node has
  // reported the error, a kill() would go to process id 0, which is this
  // script's own process group.
  if (!control.pid)
    return { unseen: "the control process could not be started" };
  let why = "the control process was not listed as a foreground application";
  try {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (control.exitCode !== null || control.signalCode !== null)
        return { unseen: "the control process ended early" };
      const list = appList(
        Math.max(1000, Math.min(10_000, until - Date.now()))
      );
      if (list === null) why = "the application list could not be read";
      else if (isForeground(entryOf(list, control.pid) ?? "")) {
        const entry = entryOf(list, pid);
        return entry === undefined
          ? { unseen: "the process is not in the application list" }
          : { shown: isForeground(entry) };
      } else
        why = "the control process was not listed as a foreground application";
      await new Promise((r) => setTimeout(r, 250));
    }
    return { unseen: why };
  } finally {
    control.kill("SIGKILL");
  }
}
