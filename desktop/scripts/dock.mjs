// macOS: whether a process has an icon of its own in the Dock, as
// LaunchServices lists it (`lsappinfo`). The smoke test asks for the UI
// server, which must have none.
import { execFileSync, spawn } from "node:child_process";

/** true when macOS lists `pid` as a foreground application (it then has a
 *  Dock icon), false when it does not, null when the list cannot be read. */
export function hasDockIcon(pid) {
  let list;
  try {
    list = execFileSync("/usr/bin/lsappinfo", ["list"], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch {
    return null;
  }
  // One entry per application: `<n>) "<name>" ASN:...`, then indented lines.
  const entry = list
    .split(/\n(?=\s*\d+\) ")/)
    .find((e) => new RegExp(`\\bpid = ${pid}\\b`).test(e));
  return entry ? /\btype="Foreground"/.test(entry) : false;
}

/**
 * Whether Dock icons can be seen from here at all. A control: a process of
 * `exe` (an app's own executable) in Node mode that sets its process title
 * gets a Dock icon, so it must be listed as a foreground application within
 * `timeoutMs`. Where it is not (no login session with a Dock, no list),
 * `hasDockIcon` would answer false for every process, and a check built on
 * it would pass without having seen anything.
 */
export async function dockIsObservable(exe, timeoutMs = 15_000) {
  const control = spawn(
    exe,
    ["-e", "process.title = 'dock-control'; setTimeout(() => {}, 120000)"],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore" }
  );
  control.on("error", () => {});
  // It could not be started. No signal for it: until Node has reported the
  // error, a kill() would go to process id 0, which is this script's own
  // process group.
  if (!control.pid) return false;
  try {
    const until = Date.now() + timeoutMs;
    while (control.exitCode === null && Date.now() < until) {
      if (hasDockIcon(control.pid) === true) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  } finally {
    control.kill("SIGKILL");
  }
}
