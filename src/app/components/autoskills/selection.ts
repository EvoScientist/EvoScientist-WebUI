// The drafts page's multi-select rules: which picks survive a re-read, and
// which drafts a bulk decision may send, at which version. A selection maps
// each picked draft's id to its updated_at and its content_digest as listed
// when it was picked.

import type { Draft, DraftList } from "@/lib/autoskills";

/** A draft as it was picked: the updated_at and the content_digest the list
 *  gave then, so a bulk decision sends the version, and vouches for the
 *  content, the pick was made on. An agent's plain file write changes the
 *  digest without the stamp, so both are needed. */
export interface Pick {
  updated_at: string;
  content_digest: string | null;
}

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
 *  are known, still in a registered project, each with what was recorded at
 *  the pick. The same selection when none drop. */
export function stillPending(
  selected: ReadonlyMap<string, Pick>,
  list: DraftList,
  registered: ReadonlySet<string> | null
): ReadonlyMap<string, Pick> {
  const pending = pendingIds(list, registered);
  const kept = [...selected].filter(([id]) => pending.has(id));
  return kept.length === selected.size ? selected : new Map(kept);
}

/** The drafts as they were picked: each with the updated_at and the
 *  content_digest recorded then, so an approval installs, and a rejection
 *  rejects, that version only (the core answers draft_changed for one
 *  rewritten since, and refuses a digest of other content). A draft with no
 *  pick recorded, or one still as it was picked, goes as listed. */
export function asSelected(
  drafts: readonly Draft[],
  selected: ReadonlyMap<string, Pick>
): Draft[] {
  return drafts.map((d) => {
    const pick = selected.get(d.proposal_id);
    return pick === undefined ||
      (pick.updated_at === d.updated_at &&
        pick.content_digest === d.content_digest)
      ? d
      : {
          ...d,
          updated_at: pick.updated_at,
          content_digest: pick.content_digest,
        };
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
