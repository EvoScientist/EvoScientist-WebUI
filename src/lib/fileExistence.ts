/**
 * Whether a file is still there after reading it failed. Both file APIs answer
 * a missing file with a generic 400, so the listing decides. Null when the
 * listing can't settle it — the read error is then reported as is.
 */

export async function workspaceFileExists(
  path: string
): Promise<boolean | null> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  try {
    const res = await fetch(
      `/api/workspace?${new URLSearchParams({ path: dir })}`
    );
    // The folder itself is gone (or no longer reachable).
    if (res.status === 400) return false;
    if (!res.ok) return null;
    const body = (await res.json()) as {
      entries?: { path: string; type: string }[];
    };
    return (body.entries ?? []).some(
      (e) => e.path === path && e.type === "file"
    );
  } catch {
    return null;
  }
}

export async function memoryFileExists(path: string): Promise<boolean | null> {
  try {
    const res = await fetch("/api/memory");
    if (!res.ok) return null;
    const body = (await res.json()) as {
      entries?: { path: string }[];
      truncated?: boolean;
    };
    if ((body.entries ?? []).some((e) => e.path === path)) return true;
    return body.truncated ? null : false;
  } catch {
    return null;
  }
}
