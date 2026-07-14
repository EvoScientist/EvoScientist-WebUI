// Auto-approve the pending tool-call interrupt while the feature is on.
//
// When `autoApprove` is true and the current interrupt carries a non-empty
// `action_requests` list, this hook fires `resumeInterrupt` with a matching
// approve decision for each request. Duplicate approvals are guarded by a
// SET of interrupt-value keys (via `interruptValueKey`) — a re-observed
// same-content interrupt (whether the reference changed or not) is skipped.
//
// The `isLoading` gate is essential: the SDK's `start()` early-returns while
// a run is in flight, silently swallowing our resume. Waiting for the
// isLoading transition avoids that race.
//
// The internal Set is cleared whenever `autoApprove` transitions or
// `resetKey` (typically threadId) changes, so a still-pending interrupt on
// re-enable or a new thread fires again.

"use client";

import { useEffect, useRef } from "react";
import { interruptValueKey } from "@/app/hooks/useChat";

interface UseAutoApproveInterruptArgs {
  autoApprove: boolean;
  interrupt: unknown;
  resumeInterrupt: (value: unknown) => void;
  /** From `useChat` — while true, the SDK is already streaming; auto-approve
   *  waits for the transition to false before firing. */
  isLoading: boolean;
  /** Optional token that, when it changes, resets the internal
   *  already-approved Set. Wire to threadId in callers that switch threads. */
  resetKey?: string | null;
}

export function useAutoApproveInterrupt({
  autoApprove,
  interrupt,
  resumeInterrupt,
  isLoading,
  resetKey,
}: UseAutoApproveInterruptArgs): void {
  const approvedIdsRef = useRef<Set<string>>(new Set());
  const boundaryRef = useRef({ resetKey, autoApprove });

  // Reset on boundary changes (thread switch, feature toggle). Fires before
  // the fire effect on the same render because effects run in declaration order.
  // Guarded by the previous boundary values so a Strict Mode mount replay
  // (which re-runs effects without any prop change) is a no-op — otherwise the
  // replay would erase the just-recorded key and approve the same interrupt twice.
  useEffect(() => {
    const previous = boundaryRef.current;
    if (
      previous.resetKey === resetKey &&
      previous.autoApprove === autoApprove
    ) {
      return;
    }
    boundaryRef.current = { resetKey, autoApprove };
    approvedIdsRef.current = new Set();
  }, [resetKey, autoApprove]);

  useEffect(() => {
    if (!autoApprove) return;
    if (isLoading) return;
    const ir = interrupt as
      | { value?: { action_requests?: unknown } }
      | null
      | undefined;
    const actionRequests = ir?.value?.action_requests;
    if (!ir || !Array.isArray(actionRequests) || actionRequests.length === 0) {
      return;
    }
    const key = interruptValueKey(ir);
    if (key === null || approvedIdsRef.current.has(key)) return;
    approvedIdsRef.current.add(key);
    resumeInterrupt({
      decisions: actionRequests.map(() => ({ type: "approve" })),
    });
    // resetKey is in the deps so a boundary change (thread switch) re-runs
    // this effect after the reset effect above cleared the Set — otherwise
    // a still-pending interrupt would be silently skipped on the new thread.
  }, [autoApprove, interrupt, resumeInterrupt, isLoading, resetKey]);
}
