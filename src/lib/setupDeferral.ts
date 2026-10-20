// "Configure later": once the user leaves the setup wizard, it does not open
// again by itself for that deployment in this browser tab. Kept in
// sessionStorage so a reload does not bring it back; a new tab asks again.

const KEY = "evoscientist-setup-later";

// When storage is unavailable (private mode, blocked site data), the choice
// lasts for this page load.
const memory = new Set<string>();

function normalise(deploymentUrl: string): string {
  return deploymentUrl.replace(/\/$/, "");
}

function stored(): string[] {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function isSetupDeferred(deploymentUrl: string): boolean {
  const url = normalise(deploymentUrl);
  return memory.has(url) || stored().includes(url);
}

export function deferSetup(deploymentUrl: string): void {
  const url = normalise(deploymentUrl);
  memory.add(url);
  try {
    const urls = stored();
    if (!urls.includes(url)) {
      window.sessionStorage.setItem(KEY, JSON.stringify([...urls, url]));
    }
  } catch {
    // The in-memory copy still holds it.
  }
}

/** Test hook. */
export function resetSetupDeferral(): void {
  memory.clear();
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}
