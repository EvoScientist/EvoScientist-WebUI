import type { ThreadItem, ThreadPage } from "@/app/hooks/useThreads";

/**
 * The loaded threads, each once. Page 0 wins, so the freshest `updated_at`
 * survives: a thread whose activity advances mid-run (every agent step
 * persists) is in page 0 with the new value and in a stale later page with
 * the old one. `revalidateFirstPage` keeps page 0 fresh, not the others.
 */
export function dedupeThreads(pages: ThreadPage[] | undefined): ThreadItem[] {
  const seen = new Set<string>();
  const out: ThreadItem[] = [];
  for (const page of pages ?? []) {
    for (const t of page.items) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

export function matchesSearch(thread: ThreadItem, search: string): boolean {
  const q = search.trim().toLowerCase();
  return !q || thread.title.toLowerCase().includes(q);
}
