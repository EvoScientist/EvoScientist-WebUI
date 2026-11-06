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
  /** `changed`: the core installed nothing because the draft changed since
   *  the page read it (approve's `draft_changed`); it is still pending. */
  failed: Array<{ draft: Draft; message: string; changed?: boolean }>;
}

type Answer = { status: number; error?: string; detail?: string } | "network";

const UNDO_MS = 10_000;

function skills(n: number): string {
  return `${n} skills`;
}

/** The success line of a decision. `placed` holds where each approved
 *  draft went as the core answered it (never the list's recorded scope,
 *  which may be stale); a draft without an entry is named without a place. */
export function decisionToast(
  action: "approve" | "reject",
  done: Draft[],
  placed: Record<string, DraftScope>,
  labels: Map<string, string>
): string {
  const n = done.length;
  if (action === "reject") {
    return n === 1
      ? `Rejected ${done[0].skill_name}.`
      : `Rejected ${skills(n)}.`;
  }
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

/** The line for one draft the core or the relay refused. */
export function decisionError(
  answer: Answer,
  draft: Draft,
  labels: Map<string, string>
): string {
  const name = draft.skill_name;
  if (answer === "network") {
    return "The WebUI server did not answer. Nothing was changed.";
  }
  const code = typeof answer.error === "string" ? answer.error : "";
  switch (code) {
    case "not_pending":
      return `${name} was already decided elsewhere.`;
    case "draft_changed":
      return `${name} changed since the page read it, so nothing was installed. Read the new version, then decide.`;
    case "not_found":
      return `${name} is no longer there.`;
    case "project_not_served":
      return `${labelFor(
        draft.workspace_dir,
        labels
      )} isn't served by this backend right now, so ${name} wasn't changed.`;
    case "approve_failed":
    case "reject_failed":
      if (answer.detail?.trim()) return `${name}: ${answer.detail}`;
      return `${name} couldn't be changed (HTTP ${answer.status}).`;
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

const SUCCESS_FLAG = {
  approve: "approved",
  reject: "rejected",
  revert: "reverted",
} as const;

async function post(
  body: Record<string, unknown> & { action: keyof typeof SUCCESS_FLAG }
): Promise<
  { ok: true; data: Record<string, unknown> } | { ok: false; answer: Answer }
> {
  const reply: RelayReply = await postRelay(body);
  if (reply === "network") return { ok: false, answer: "network" };
  const data = reply.data;
  if (reply.ok && data[SUCCESS_FLAG[body.action]] === true) {
    return { ok: true, data };
  }
  return {
    ok: false,
    answer: {
      status: reply.status,
      error: typeof data.error === "string" ? data.error : undefined,
      detail: typeof data.detail === "string" ? data.detail : undefined,
    },
  };
}

function isScope(value: unknown): value is DraftScope {
  return value === "workspace" || value === "global";
}

async function decideAll(
  drafts: Draft[],
  bodyOf: (d: Draft) => Parameters<typeof post>[0],
  labels: Map<string, string>,
  failure: (answer: Answer, d: Draft) => string
): Promise<
  DecisionResult & {
    placed: Record<string, DraftScope>;
    operations: Record<string, Draft["operation"]>;
  }
> {
  const result: DecisionResult = { done: [], failed: [] };
  // Where each approval went: the core's answer, else the scope picked for
  // it (the core installs where it is told).
  const placed: Record<string, DraftScope> = {};
  // What each approval did, as the core answered: a draft rewritten after
  // the list was read may have become an update, or stopped being one.
  const operations: Record<string, Draft["operation"]> = {};
  for (const draft of drafts) {
    const body = bodyOf(draft);
    const out = await post(body);
    if (out.ok) {
      result.done.push(draft);
      const scope = isScope(out.data.scope) ? out.data.scope : body.scope;
      if (isScope(scope)) placed[draft.proposal_id] = scope;
      const operation = out.data.operation;
      if (operation === "create" || operation === "update") {
        operations[draft.proposal_id] = operation;
      }
    } else {
      const message = failure(out.answer, draft);
      if (out.answer !== "network" && out.answer.error === "draft_changed") {
        result.failed.push({ draft, message, changed: true });
      } else {
        result.failed.push({ draft, message });
      }
    }
  }
  return { ...result, placed, operations };
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
 *  `onReverted` hears which drafts an Undo moved back to Pending, with that
 *  Undo's own re-read of the drafts (settling when it does). */
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
      labels: Map<string, string>
    ): (() => Promise<void>) => {
      let used = false;
      return () => {
        if (used) return Promise.resolve();
        used = true;
        return track(async () => {
          const inUse: Draft[] = [];
          const { done, failed } = await decideAll(
            revertible,
            (d) => ({ action: "revert", proposal_id: d.proposal_id }),
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
              if (code === "revert_failed") {
                inUse.push(d);
                return `${d.skill_name} couldn't be moved back to Pending: a file is in use. Try Undo again in a moment.`;
              }
              return decisionError(answer, d, labels);
            }
          );
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
            toast.success(
              done.length === 1
                ? `Moved ${done[0].skill_name} back to Pending.`
                : `Moved ${skills(done.length)} back to Pending.`
            );
          }
          toastErrors(
            failed,
            inUse.length > 0
              ? {
                  duration: UNDO_MS,
                  action: { label: "Undo", onClick: undoer(inUse, labels) },
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
        const { placed, operations, ...result } = await decideAll(
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
              : { action, proposal_id: d.proposal_id },
          labels,
          (answer, d) => decisionError(answer, d, labels)
        );
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
          const text = decisionToast(action, result.done, placed, labels);
          if (revertible.length > 0) {
            toast.success(text, {
              duration: UNDO_MS,
              action: { label: "Undo", onClick: undoer(revertible, labels) },
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
