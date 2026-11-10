"use client";

import { createElement, useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { refreshAutoSkills } from "@/app/hooks/useAutoSkills";
import { notifyTeamsChanged } from "@/app/hooks/useTeams";
import {
  autoSkillsReadOnlyReason,
  isRevertible,
  labelFor,
  projectLabels,
  type Draft,
  type DraftScope,
} from "@/lib/autoskills";
import type { Project } from "@/lib/projects";
import {
  isRelayRefusal,
  postRelay,
  type RelayReply,
} from "@/lib/autoskillsRelay";

export interface DecisionResult {
  done: Draft[];
  /** `changed`: the core decided nothing because the draft changed since
   *  the page read it (`draft_changed`, for an approve and a reject alike);
   *  it is still pending. */
  failed: Array<{
    draft: Draft;
    message: string;
    changed?: boolean;
    /** Never sent: an earlier draft of the batch drew a failure that
     *  would repeat for this one (the relay's own, or the core refusing
     *  the relay's secret). */
    unsent?: boolean;
  }>;
}

/** An answer that wasn't a success: the HTTP status, the body's `error` and
 *  `detail`, and the draft's own status when the body names one
 *  (`not_pending`). "network": the fetch to the WebUI server rejected. */
type Answer =
  | { status: number; error?: string; detail?: string; draftStatus?: string }
  | "network";

const UNDO_MS = 10_000;

function skills(n: number): string {
  return `${n} skills`;
}

const NO_IDS: ReadonlySet<string> = new Set();

/** The success line of a decision. `placed` holds where each approved
 *  draft went as the core answered it (never the list's recorded scope,
 *  which may be stale); a draft without an entry is named without a place.
 *  `kept` holds the approved drafts whose project keeps its own copy of the
 *  skill, as the core answered (`workspace_shadow`): the approval updated
 *  the global one, and that project goes on using its own. */
export function decisionToast(
  action: "approve" | "reject",
  done: Draft[],
  placed: Record<string, DraftScope>,
  labels: Map<string, string>,
  kept: ReadonlySet<string> = NO_IDS
): string {
  const n = done.length;
  if (action === "reject") {
    return n === 1
      ? `Rejected ${done[0].skill_name}.`
      : `Rejected ${skills(n)}.`;
  }
  return installedLine(done, placed, labels) + keptLine(done, labels, kept);
}

function installedLine(
  done: Draft[],
  placed: Record<string, DraftScope>,
  labels: Map<string, string>
): string {
  const n = done.length;
  const scopeOf = (d: Draft): DraftScope | undefined =>
    Object.hasOwn(placed, d.proposal_id) ? placed[d.proposal_id] : undefined;
  if (n === 1) {
    const d = done[0];
    const scope = scopeOf(d);
    if (scope === "global") {
      return `Installed ${d.skill_name} into all projects (global).`;
    }
    if (scope === "workspace") {
      return `Installed ${d.skill_name} into ${labelFor(
        d.workspace_dir,
        labels
      )}/skills.`;
    }
    return `Installed ${d.skill_name}.`;
  }
  if (done.every((d) => scopeOf(d) === "global")) {
    return `Installed ${skills(n)} into all projects (global).`;
  }
  if (
    done.every(
      (d) =>
        scopeOf(d) === "workspace" && d.workspace_dir === done[0].workspace_dir
    )
  ) {
    return `Installed ${skills(n)} into ${labelFor(
      done[0].workspace_dir,
      labels
    )}/skills.`;
  }
  return `Installed ${skills(n)}.`;
}

/** " {project} keeps its own copy." for each project that keeps one, in the
 *  drafts' order ("copies" for several of one project's); "" for none. */
function keptLine(
  done: Draft[],
  labels: Map<string, string>,
  kept: ReadonlySet<string>
): string {
  const byProject = new Map<string, number>();
  for (const d of done) {
    if (!kept.has(d.proposal_id)) continue;
    byProject.set(d.workspace_dir, (byProject.get(d.workspace_dir) ?? 0) + 1);
  }
  let line = "";
  for (const [key, count] of byProject) {
    line += ` ${labelFor(key, labels)} keeps its own ${
      count === 1 ? "copy" : "copies"
    }.`;
  }
  return line;
}

/** The line for one draft the core or the relay refused, for a decision or
 *  an Undo. `action` words the refusals that depend on what was asked
 *  (`draft_changed`). */
export function decisionError(
  answer: Answer,
  draft: Draft,
  labels: Map<string, string>,
  action: "approve" | "reject" = "approve"
): string {
  const name = draft.skill_name;
  // The relay may have passed the request on before its answer was lost,
  // and a core that answers late may still decide: never "nothing changed".
  // Every decision and Undo reads the drafts again when it ends.
  if (answer === "network") {
    return `The WebUI server did not answer, so the page can't tell whether ${name} changed. The drafts are being read again.`;
  }
  const code = typeof answer.error === "string" ? answer.error : "";
  switch (code) {
    case "not_pending":
      // What the draft is now, as the core says: the decision may be this
      // page's own (made, then the page left and came back before the list
      // was read again), so never "elsewhere".
      if (answer.draftStatus === "approved") {
        return `${name} is already approved.`;
      }
      if (answer.draftStatus === "rejected") {
        return `${name} is already rejected.`;
      }
      return `${name} is no longer pending.`;
    case "draft_changed":
      return action === "reject"
        ? `${name} changed since the page read it, so it wasn't rejected. Read the new version, then decide.`
        : `${name} changed since the page read it, so nothing was installed. Read the new version, then decide.`;
    case "not_found":
      return `${name} is no longer there.`;
    case "project_not_served":
      return `${labelFor(
        draft.workspace_dir,
        labels
      )} isn't served by this backend right now, so ${name} wasn't changed.`;
    case "no_project":
      return `${name} belongs to no registered project, so it wasn't changed.`;
    case "revert_unavailable":
      return `${name} can't be moved back: EvoScientist can't undo this decision.`;
    case "approve_failed":
    case "reject_failed":
      if (answer.detail?.trim()) return `${name}: ${answer.detail}`;
      return `${name} couldn't be changed (HTTP ${answer.status}).`;
    case "backend_timeout":
      return `EvoScientist did not answer in time, so the page can't tell whether ${name} changed. The drafts are being read again.`;
    case "local_secret_required":
      return (
        autoSkillsReadOnlyReason({
          writable: false,
          reason: "secret_rejected",
        }) ?? ""
      );
    default:
      if (isRelayRefusal(code)) {
        return (
          autoSkillsReadOnlyReason({
            writable: false,
            reason: code,
          }) ?? ""
        );
      }
      return `${name} couldn't be changed (HTTP ${answer.status}).`;
  }
}

/** Whether the page can't tell that a request reached the core: the fetch
 *  to the WebUI server rejected, or the relay couldn't reach the backend or
 *  gave up waiting for its answer. */
function mayNotHaveArrived(answer: Answer): boolean {
  if (answer === "network") return true;
  return (
    answer.error === "backend_timeout" || answer.error === "backend_unreachable"
  );
}

const SUCCESS_FLAG = {
  approve: "approved",
  reject: "rejected",
  revert: "reverted",
} as const;

async function post(
  body: Record<string, unknown> & { action: keyof typeof SUCCESS_FLAG }
): Promise<
  | {
      ok: true;
      data: Record<string, unknown>;
      /** The `updated_at` this decision wrote, verbatim; null when the
       *  answer names none (an EvoScientist before the answers had one). */
      updatedAt: string | null;
    }
  | { ok: false; answer: Answer }
> {
  const reply: RelayReply = await postRelay(body);
  if (reply === "network") return { ok: false, answer: "network" };
  const data = reply.data;
  if (reply.ok && data[SUCCESS_FLAG[body.action]] === true) {
    const stamp = data.updated_at;
    return {
      ok: true,
      data,
      updatedAt: typeof stamp === "string" && stamp ? stamp : null,
    };
  }
  return {
    ok: false,
    answer: {
      status: reply.status,
      error: typeof data.error === "string" ? data.error : undefined,
      detail: typeof data.detail === "string" ? data.detail : undefined,
      draftStatus: typeof data.status === "string" ? data.status : undefined,
    },
  };
}

function isScope(value: unknown): value is DraftScope {
  return value === "workspace" || value === "global";
}

/** Whether a failure is the same for every draft: the relay's own (the
 *  fetch to the WebUI server rejected, or one of the relay's refusals), or
 *  the core refusing the relay's secret (the WebUI and the core use
 *  different data folders). Every further draft of the batch would draw it
 *  again, and each request may wait out the relay's timeout first. */
function repeatsForEveryDraft(answer: Answer): boolean {
  if (answer === "network") return true;
  if (typeof answer.error !== "string") return false;
  return (
    answer.error === "local_secret_required" || isRelayRefusal(answer.error)
  );
}

/** The one line for the drafts a batch cut short never sent. */
function notSentLine(n: number): string {
  return n === 1
    ? "1 more draft was not sent."
    : `${n} more drafts were not sent.`;
}

/** Send the drafts one after another. The batch ends at the first failure
 *  that would repeat for every draft: the drafts after it are not sent
 *  (`unsent`, all with the one line that counts them). */
async function decideAll(
  drafts: Draft[],
  bodyOf: (d: Draft) => Parameters<typeof post>[0],
  labels: Map<string, string>,
  failure: (answer: Answer, d: Draft) => string,
  // Hears of each draft as its own answer says it went through, while the
  // rest of the batch is still out.
  onDone?: (d: Draft) => void
): Promise<
  DecisionResult & {
    placed: Record<string, DraftScope>;
    operations: Record<string, Draft["operation"]>;
    statuses: Map<string, string>;
    kept: Set<string>;
    stamps: Map<string, string>;
  }
> {
  const result: DecisionResult = { done: [], failed: [] };
  // Where each approval went: the core's answer, else the scope picked for
  // it (the core installs where it is told).
  const placed: Record<string, DraftScope> = {};
  // What each approval did, as the core answered: a draft rewritten after
  // the list was read may have become an update, or stopped being one.
  const operations: Record<string, Draft["operation"]> = {};
  // The status each answer names: a revert says where the draft went.
  const statuses = new Map<string, string>();
  // The approvals that left the project's own copy of the skill in place
  // (`workspace_shadow`, its path): the core updated the global one only.
  const kept = new Set<string>();
  // The updated_at each decision wrote, for the answers that name one: the
  // version an Undo of that decision is for.
  const stamps = new Map<string, string>();
  for (const [index, draft] of drafts.entries()) {
    const body = bodyOf(draft);
    const out = await post(body);
    if (out.ok) {
      result.done.push(draft);
      onDone?.(draft);
      if (out.updatedAt !== null) stamps.set(draft.proposal_id, out.updatedAt);
      const scope = isScope(out.data.scope) ? out.data.scope : body.scope;
      if (isScope(scope)) placed[draft.proposal_id] = scope;
      const operation = out.data.operation;
      if (operation === "create" || operation === "update") {
        operations[draft.proposal_id] = operation;
      }
      if (typeof out.data.status === "string") {
        statuses.set(draft.proposal_id, out.data.status);
      }
      const shadow = out.data.workspace_shadow;
      if (typeof shadow === "string" && shadow.trim()) {
        kept.add(draft.proposal_id);
      }
    } else {
      const message = failure(out.answer, draft);
      if (out.answer !== "network" && out.answer.error === "draft_changed") {
        result.failed.push({ draft, message, changed: true });
      } else {
        result.failed.push({ draft, message });
      }
      if (repeatsForEveryDraft(out.answer)) {
        const rest = drafts.slice(index + 1);
        const line = notSentLine(rest.length);
        for (const d of rest) {
          result.failed.push({ draft: d, message: line, unsent: true });
        }
        break;
      }
    }
  }
  return { ...result, placed, operations, statuses, kept, stamps };
}

/** The success lines of an Undo, by where the core says each draft went:
 *  back to pending (also an answer that names no status), or to rejected
 *  (an approval auto mode made is never pending again without a review). */
export function revertToasts(
  done: Draft[],
  statuses: ReadonlyMap<string, string>
): string[] {
  const rejected = done.filter(
    (d) => statuses.get(d.proposal_id) === "rejected"
  );
  const pending = done.filter(
    (d) => statuses.get(d.proposal_id) !== "rejected"
  );
  const lines: string[] = [];
  if (pending.length > 0) {
    lines.push(
      pending.length === 1
        ? `Moved ${pending[0].skill_name} back to Pending.`
        : `Moved ${skills(pending.length)} back to Pending.`
    );
  }
  if (rejected.length > 0) {
    lines.push(
      rejected.length === 1
        ? `Moved ${rejected[0].skill_name} to Rejected.`
        : `Moved ${skills(rejected.length)} to Rejected.`
    );
  }
  return lines;
}

/** Read the drafts and experts again, in the background: the drafts GET has
 *  no timeout, and a re-read that fails or never answers must hold neither
 *  the toasts of a decision that was made nor the controls. The promise
 *  settles once the drafts read does, never rejecting. */
function reread(): Promise<void> {
  let drafts: Promise<void> = Promise.resolve();
  try {
    drafts = Promise.resolve(refreshAutoSkills()).then(
      () => undefined,
      () => {
        // The next poll reads again.
      }
    );
  } catch {
    // Same.
  }
  try {
    notifyTeamsChanged();
  } catch {
    // Same.
  }
  return drafts;
}

function toastErrors(
  failed: DecisionResult["failed"],
  options?: Parameters<typeof toast.error>[1]
): void {
  if (failed.length > 0) {
    const lines = [...new Set(failed.map((f) => f.message))];
    toast.error(
      createElement(
        "div",
        null,
        lines.map((line) => createElement("div", { key: line }, line))
      ),
      ...(options ? [options] : [])
    );
  }
}

/** Approve and reject drafts through the relay, with the toasts and Undo.
 *  `onReverted` hears which drafts an Undo moved back (to Pending, or to
 *  Rejected when the core says so), with that Undo's own re-read of the
 *  drafts (settling when it does). An Undo moves back only the decision it
 *  was offered for, never a later one of the same draft. */
export function useDraftActions(
  projects: readonly Project[],
  options: {
    onReverted?(drafts: Draft[], reread: Promise<void>): void;
  } = {}
): {
  approve(
    drafts: Draft[],
    scopes?: Record<string, DraftScope>
  ): Promise<DecisionResult>;
  reject(drafts: Draft[]): Promise<DecisionResult>;
  busy: boolean;
} {
  const [running, setRunning] = useState(0);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const onRevertedRef = useRef(options.onReverted);
  onRevertedRef.current = options.onReverted;
  // How many approvals and rejections of each draft went through this hook.
  // An Undo is for the decision that offered it: a draft decided again since
  // was pending once more in between (a revert whose answer was lost, or one
  // made elsewhere), and a revert now would take back the newer decision.
  const decidedRef = useRef(new Map<string, number>());

  const track = useCallback(async <T>(run: () => Promise<T>): Promise<T> => {
    setRunning((n) => n + 1);
    try {
      return await run();
    } finally {
      setRunning((n) => n - 1);
    }
  }, []);

  const undoer = useCallback(
    (
      revertible: Draft[],
      labels: Map<string, string>,
      // The updated_at each draft's decision wrote, as its answer named it.
      // The revert sends it, and the core moves the draft only while it is
      // still as that decision left it. A draft without one (an older
      // EvoScientist) sends null, which checks nothing. An Undo offered
      // again sends the same: a revert the core couldn't finish wrote none.
      stamps: ReadonlyMap<string, string>,
      // The decisions this Undo is for: each draft's count as its decision
      // left it. An Undo offered again gets the counts of the Undo that
      // offered it, since a draft may be decided again while a revert is out.
      made: ReadonlyMap<string, number> = new Map(
        revertible.map((d) => [
          d.proposal_id,
          decidedRef.current.get(d.proposal_id) ?? 0,
        ])
      )
    ): (() => Promise<void>) => {
      let used = false;
      return () => {
        if (used) return Promise.resolve();
        used = true;
        // Checked at each click: the drafts decided again since are left
        // out, and with none left nothing is sent or said.
        const mine = revertible.filter(
          (d) =>
            (decidedRef.current.get(d.proposal_id) ?? 0) ===
            made.get(d.proposal_id)
        );
        if (mine.length === 0) return Promise.resolve();
        return track(async () => {
          // The drafts Undo is offered for again: a revert the core
          // couldn't finish, or one the page can't tell reached the core.
          // A second revert of a draft already back answers not_decided.
          const retryable: Draft[] = [];
          // Such a failure also ends the batch: the drafts after it were
          // never sent, and get their Undo back with it.
          let lost = false;
          const { done, failed, statuses } = await decideAll(
            mine,
            (d) => ({
              action: "revert",
              proposal_id: d.proposal_id,
              expected_updated_at: stamps.get(d.proposal_id) ?? null,
            }),
            labels,
            (answer, d) => {
              const code =
                answer !== "network" && typeof answer.error === "string"
                  ? answer.error
                  : "";
              if (code === "skill_changed") {
                return `${d.skill_name} changed since it was installed, so it stays installed.`;
              }
              if (code === "not_decided") {
                return `${d.skill_name} is already back in Pending.`;
              }
              // The draft isn't as the decision left it (the core checks
              // this before not_decided): nothing was moved, the draft is
              // not reported as moved back, and no other Undo is offered.
              if (code === "draft_changed") {
                return `${d.skill_name} changed since this Undo was offered, so nothing was moved. The drafts are being read again.`;
              }
              if (code === "revert_failed") {
                retryable.push(d);
                return `${d.skill_name} couldn't be moved back to Pending: a file is in use. Try Undo again in a moment.`;
              }
              if (mayNotHaveArrived(answer)) {
                retryable.push(d);
                lost = true;
              }
              return decisionError(answer, d, labels);
            }
          );
          if (lost) {
            retryable.push(
              ...failed.filter((f) => f.unsent).map((f) => f.draft)
            );
          }
          // The re-read starts here, after the revert answered and BEFORE
          // the page hears of the Undo, which gets its promise. The page
          // holds the drafts and, once this read has settled, releases them
          // in a render with no read of the list in flight: a newer read may
          // replace this one (SWR discards it without writing the list, and
          // its promise still settles), and every such read started after
          // the revert too. Don't swap the two calls.
          const rereading = reread();
          if (done.length > 0) {
            try {
              onRevertedRef.current?.(done, rereading);
            } catch {
              // The toasts below still say what happened.
            }
            // As the core answered: one line for the drafts back in
            // Pending, one for those it moved to Rejected.
            for (const line of revertToasts(done, statuses)) {
              toast.success(line);
            }
          }
          toastErrors(
            failed,
            retryable.length > 0
              ? {
                  duration: UNDO_MS,
                  action: {
                    label: "Undo",
                    onClick: undoer(retryable, labels, stamps, made),
                  },
                }
              : undefined
          );
        });
      };
    },
    [track]
  );

  const decide = useCallback(
    (
      action: "approve" | "reject",
      drafts: Draft[],
      scopes: Record<string, DraftScope>
    ) =>
      track(async () => {
        const labels = projectLabels(projectsRef.current);
        const decided = await decideAll(
          drafts,
          (d) =>
            action === "approve"
              ? {
                  action,
                  proposal_id: d.proposal_id,
                  // Only a scope picked for this draft: the list's recorded
                  // one may be stale (a draft resubmitted with another), and
                  // without one the core installs where it records now.
                  scope: Object.hasOwn(scopes, d.proposal_id)
                    ? scopes[d.proposal_id]
                    : null,
                  // The version the page read: one a resubmit rewrote since
                  // is refused (draft_changed), never installed unread. A
                  // draft read without one checks nothing.
                  expected_updated_at: d.updated_at || null,
                }
              : {
                  action,
                  proposal_id: d.proposal_id,
                  // The same for a reject: the version read, never a
                  // rewrite nobody saw. It installs nothing, so no scope.
                  expected_updated_at: d.updated_at || null,
                },
          labels,
          (answer, d) => decisionError(answer, d, labels, action),
          (d) => {
            const counts = decidedRef.current;
            counts.set(d.proposal_id, (counts.get(d.proposal_id) ?? 0) + 1);
          }
        );
        const { placed, operations, kept, stamps, done, failed } = decided;
        const result: DecisionResult = { done, failed };
        reread();
        if (result.done.length > 0) {
          // Undo needs a backup the core keeps for a create only: as the core
          // answered, else as the list read it.
          const revertible = result.done.filter((d) =>
            isRevertible(
              Object.hasOwn(operations, d.proposal_id)
                ? { ...d, operation: operations[d.proposal_id] }
                : d,
              action
            )
          );
          const text = decisionToast(action, result.done, placed, labels, kept);
          if (revertible.length > 0) {
            toast.success(text, {
              duration: UNDO_MS,
              action: {
                label: "Undo",
                onClick: undoer(revertible, labels, stamps),
              },
            });
          } else {
            toast.success(text);
          }
        }
        toastErrors(result.failed);
        return result;
      }),
    [track, undoer]
  );

  const approve = useCallback(
    (drafts: Draft[], scopes: Record<string, DraftScope> = {}) =>
      decide("approve", drafts, scopes),
    [decide]
  );
  const reject = useCallback(
    (drafts: Draft[]) => decide("reject", drafts, {}),
    [decide]
  );

  return { approve, reject, busy: running > 0 };
}
