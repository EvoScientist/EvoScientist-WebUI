// macOS: whether a process has an icon of its own in the Dock, as
// LaunchServices lists it (`lsappinfo`). The smoke test asks for the UI
// server, which must have none.
import { execFileSync } from "node:child_process";

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
