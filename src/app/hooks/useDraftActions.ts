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
  failed: Array<{ draft: Draft; message: string }>;
}

type Answer = { status: number; error?: string; detail?: string } | "network";

const UNDO_MS = 10_000;

function skills(n: number): string {
  return `${n} skills`;
}

/** The success line of a decision. */
export function decisionToast(
  action: "approve" | "reject",
  done: Draft[],
  scopes: Record<string, DraftScope>,
  labels: Map<string, string>
): string {
  const n = done.length;
  if (action === "reject") {
    return n === 1
      ? `Rejected ${done[0].skill_name}.`
      : `Rejected ${skills(n)}.`;
  }
  const scopeOf = (d: Draft) => scopes[d.proposal_id] ?? d.scope;
  if (n === 1) {
    const d = done[0];
    return scopeOf(d) === "global"
      ? `Installed ${d.skill_name} into all projects (global).`
      : `Installed ${d.skill_name} into ${labelFor(
          d.workspace_dir,
          labels
        )}/skills.`;
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
): Promise<{ ok: true } | { ok: false; answer: Answer }> {
  const reply: RelayReply = await postRelay(body);
  if (reply === "network") return { ok: false, answer: "network" };
  const data = reply.data;
  if (reply.ok && data[SUCCESS_FLAG[body.action]] === true) {
    return { ok: true };
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

async function decideAll(
  drafts: Draft[],
  bodyOf: (d: Draft) => Parameters<typeof post>[0],
  labels: Map<string, string>,
  failure: (answer: Answer, d: Draft) => string
): Promise<DecisionResult> {
  const result: DecisionResult = { done: [], failed: [] };
  for (const draft of drafts) {
    const out = await post(bodyOf(draft));
    if (out.ok) result.done.push(draft);
    else {
      result.failed.push({ draft, message: failure(out.answer, draft) });
    }
  }
  return result;
}

/** Read the drafts and experts again; a failure here must not hide the
 *  toasts of a decision that was made. */
async function reread(): Promise<void> {
  try {
    await refreshAutoSkills();
  } catch {
    // The next poll reads again.
  }
  try {
    notifyTeamsChanged();
  } catch {
    // Same.
  }
}

function toastErrors(failed: DecisionResult["failed"]): void {
  if (failed.length > 0) {
    const lines = [...new Set(failed.map((f) => f.message))];
    toast.error(
      createElement(
        "div",
        null,
        lines.map((line) => createElement("div", { key: line }, line))
      )
    );
  }
}

/** Approve and reject drafts through the relay, with the toasts and Undo. */
export function useDraftActions(projects: readonly Project[]): {
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

  const track = useCallback(async <T>(run: () => Promise<T>): Promise<T> => {
    setRunning((n) => n + 1);
    try {
      return await run();
    } finally {
      setRunning((n) => n - 1);
    }
  }, []);

  const undoer = useCallback(
    (revertible: Draft[], labels: Map<string, string>) => {
      let used = false;
      return () => {
        if (used) return Promise.resolve();
        used = true;
        return track(async () => {
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
              return decisionError(answer, d, labels);
            }
          );
          await reread();
          if (done.length > 0) {
            toast.success(
              done.length === 1
                ? `Moved ${done[0].skill_name} back to Pending.`
                : `Moved ${skills(done.length)} back to Pending.`
            );
          }
          toastErrors(failed);
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
        const result = await decideAll(
          drafts,
          (d) =>
            action === "approve"
              ? {
                  action,
                  proposal_id: d.proposal_id,
                  scope: scopes[d.proposal_id] ?? d.scope,
                }
              : { action, proposal_id: d.proposal_id },
          labels,
          (answer, d) => decisionError(answer, d, labels)
        );
        await reread();
        if (result.done.length > 0) {
          const revertible = result.done.filter((d) => isRevertible(d, action));
          const text = decisionToast(action, result.done, scopes, labels);
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
