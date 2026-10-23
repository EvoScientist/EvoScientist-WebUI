// Where a link or a navigation from the WebUI goes: the UI's own origin stays
// in the app (the WebUI opens same-origin links with target="_blank"), web
// and mail links open in the system browser, anything else is blocked.

export type LinkTarget = "app" | "browser" | "block";

const EXTERNAL = new Set(["http:", "https:", "mailto:"]);

export function classifyLink(url: string, uiOrigin: string | null): LinkTarget {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "block";
  }
  if (uiOrigin !== null && u.origin === uiOrigin) return "app";
  return EXTERNAL.has(u.protocol) ? "browser" : "block";
}
