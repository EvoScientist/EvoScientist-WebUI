"use client";

import { useEffect, useRef } from "react";
import { interruptValueKey } from "@/app/hooks/useChat";
import {
  buildToolApprovalResume,
  interruptIdOf,
  type ActionRequest,
} from "@/lib/hitl";
import { autoApproveDecisions } from "@/lib/hitlPolicy";

interface UseAutoApproveInterruptArgs {
  autoApprove: boolean;
  interrupt: unknown;
  resumeInterrupt: (value: unknown) => void;
  isLoading: boolean;
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
    const decisions = autoApproveDecisions(actionRequests as ActionRequest[]);
    if (decisions === null) return;
    const key = interruptValueKey(ir);
    if (key === null || approvedIdsRef.current.has(key)) return;
    approvedIdsRef.current.add(key);
    resumeInterrupt(buildToolApprovalResume(interruptIdOf(ir), { decisions }));
  }, [autoApprove, interrupt, resumeInterrupt, isLoading, resetKey]);
}
