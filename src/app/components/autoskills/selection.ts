// The drafts page's multi-select rules: which picks survive a re-read, and
// which drafts a bulk decision may send, at which version. A selection maps
// each picked draft's id to its updated_at as listed when it was picked.

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

/** The picks of `selected` still pending in `list`, and, once the projects
 *  are known, still in a registered project, each with its recorded stamp.
 *  The same selection when none drop. */
export function stillPending(
  selected: ReadonlyMap<string, string>,
  list: DraftList,
  registered: ReadonlySet<string> | null
): ReadonlyMap<string, string> {
  const pending = pendingIds(list, registered);
  const kept = [...selected].filter(([id]) => pending.has(id));
  return kept.length === selected.size ? selected : new Map(kept);
}

/** The drafts as they were picked: each with the updated_at recorded then,
 *  so an approval installs that version only (the core answers
 *  draft_changed for one rewritten since). A draft with no stamp recorded,
 *  or not rewritten, goes as listed. */
export function asSelected(
  drafts: readonly Draft[],
  selected: ReadonlyMap<string, string>
): Draft[] {
  return drafts.map((d) => {
    const stamp = selected.get(d.proposal_id);
    return stamp === undefined || stamp === d.updated_at
      ? d
      : { ...d, updated_at: stamp };
  });
}

/** The drafts of a decision still pending in `list` and, once the projects
 *  are known, in a registered project, each as the decision holds it: what
 *  its question may still name (the rule that prunes the selection; while
 *  the projects are read again the question waits, it doesn't go). None
 *  while the drafts aren't known. */
export function stillListed(
  drafts: readonly Draft[],
  list: DraftList | null,
  registered: ReadonlySet<string> | null
): Draft[] {
  if (!list) return [];
  const pending = pendingIds(list, registered);
  return drafts.filter((d) => pending.has(d.proposal_id));
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
