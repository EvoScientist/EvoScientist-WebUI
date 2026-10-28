// The window's preload. It runs sandboxed, so it may require only "electron"
// and nothing local (type imports are erased). Two jobs:
// - On the WebUI's origin (D6): before any page script runs, ask the main
//   process for the backend URL and merge it into the WebUI's saved config
//   (`localStorage['evoscientist-config']`, read by `getConfig()` in
//   src/lib/config.ts), keeping the other keys, so ConfigDialog never opens.
//   Then expose the bridge that W01 reads in src/lib/desktop.ts
//   (`window.evoscientistDesktop`): `restartBackend()` and `defaultFolder`
//   (W03d); W04 adds its update members. The main process answers both only
//   for the UI's own origin.
// - On the status page (file:): expose what it needs to show the current
//   screen and run its actions.
import { contextBridge, ipcRenderer } from "electron";
import type { ActionId, Screen } from "./screens";

const CONFIG_KEY = "evoscientist-config";

/** Puts the backend URL into the WebUI's saved settings before its first script runs. */
function handOverBackendUrl(): void {
  const url = ipcRenderer.sendSync("desktop:backend-url") as string | null;
  if (!url) return;
  let current: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      current = parsed as Record<string, unknown>;
  } catch {
    // A broken saved value is replaced.
  }
  localStorage.setItem(
    CONFIG_KEY,
    JSON.stringify({ ...current, deploymentUrl: url })
  );
}

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("evoStatus", {
    get: (): Promise<Screen | null> => ipcRenderer.invoke("status:get"),
    onScreen: (cb: (s: Screen) => void) => {
      ipcRenderer.on("status:screen", (_e, s: Screen) => cb(s));
    },
    act: (id: ActionId, arg?: unknown): Promise<void> =>
      ipcRenderer.invoke("status:act", id, arg),
  });
} else {
  try {
    handOverBackendUrl();
  } catch {
    // Storage refused: the WebUI then asks for the URL itself.
  }
  exposeBridge();
}

/** Exposes `window.evoscientistDesktop`; `defaultFolder` only when the main
 *  process has one (the Documents folder resolved). */
function exposeBridge(): void {
  const folder = ipcRenderer.sendSync("desktop:default-folder") as
    | string
    | null;
  contextBridge.exposeInMainWorld("evoscientistDesktop", {
    restartBackend: (): Promise<{ ok: boolean; code?: string }> =>
      ipcRenderer.invoke("desktop:restart-backend"),
    ...(folder ? { defaultFolder: folder } : {}),
  });
}
