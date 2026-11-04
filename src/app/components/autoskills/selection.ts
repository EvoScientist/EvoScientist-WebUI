// The drafts page's multi-select rules: which picks survive a re-read, and
// which drafts a bulk decision may send.

import type { Draft, DraftList } from "@/lib/autoskills";

function pendingIds(
  list: DraftList,
  registered: ReadonlySet<string> | null
): Set<string> {
  return new Set(
    list.drafts
      .filter(
        (d) =>
          d.status === "pending" &&
          (registered === null || registered.has(d.workspace_dir))
      )
      .map((d) => d.proposal_id)
  );
}

/** The ids of `selected` still pending in `list`, and, once the projects
 *  are known, still in a registered project. The same set when none drop. */
export function stillPending(
  selected: ReadonlySet<string>,
  list: DraftList,
  registered: ReadonlySet<string> | null
): ReadonlySet<string> {
  const pending = pendingIds(list, registered);
  const kept = [...selected].filter((id) => pending.has(id));
  return kept.length === selected.size ? selected : new Set(kept);
}

/** The drafts a bulk decision may send: still pending in `list` and in a
 *  registered project; none while either isn't known. The selection is
 *  pruned by the same rule on every change, so this only guards the send. */
export function decidable(
  drafts: readonly Draft[],
  list: DraftList | null,
  registered: ReadonlySet<string> | null
): Draft[] {
  if (!list || !registered) return [];
  const pending = pendingIds(list, registered);
  return drafts.filter((d) => pending.has(d.proposal_id));
}
