"use client";

import { useEffect, useRef } from "react";
import { interruptValueKey } from "@/app/hooks/useChat";
import {
  buildToolApprovalResume,
  interruptIdOf,
  type ActionRequest,
} from "@/lib/hitl";
import type { ApprovalPolicy } from "@/app/hooks/useApprovalPolicy";
import { resolveApprovalDecisions } from "@/lib/hitlPolicy";

interface UseAutoApproveInterruptArgs {
  autoApprove: boolean;
  interrupt: unknown;
  resumeInterrupt: (value: unknown) => void;
  isLoading: boolean;
  resetKey?: string | null;
  /** What the deployment's own policy says about the pending interrupt. Its
   *  decisions resume the run even with auto-approve off (an allow-listed
   *  command never prompts in the TUI either); without it only the local
   *  auto-approve policy applies. */
  policy?: ApprovalPolicy;
}

export function useAutoApproveInterrupt({
  autoApprove,
  interrupt,
  resumeInterrupt,
  isLoading,
  resetKey,
  policy,
}: UseAutoApproveInterruptArgs): void {
  const approvedIdsRef = useRef<Set<string>>(new Set());
  // Interrupts resumed with the deployment's decision. Kept apart from the set
  // above because toggling auto-approve deliberately re-arms the local policy,
  // and that must not replay a decision the toggle had no part in.
  const serverResolvedRef = useRef<Set<string>>(new Set());
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
    if (previous.resetKey !== resetKey) serverResolvedRef.current = new Set();
  }, [resetKey, autoApprove]);

  const policyKey = policy?.interruptKey ?? null;
  const policyChecking = policy?.checking ?? false;
  const policyDecisions = policy?.decisions ?? null;

  useEffect(() => {
    if (isLoading) return;
    // The local policy must not jump ahead of the deployment's answer: when the
    // deployment has one, that is the decision the run gets.
    if (policyChecking) return;
    const ir = interrupt as
      | { value?: { action_requests?: unknown } }
      | null
      | undefined;
    const actionRequests = ir?.value?.action_requests;
    if (!ir || !Array.isArray(actionRequests) || actionRequests.length === 0) {
      return;
    }
    const key = interruptValueKey(ir);
    if (key === null) return;
    // Decisions are only ever applied to the interrupt they were made for.
    const serverDecisions = policyKey === key ? policyDecisions : null;
    const decisions = resolveApprovalDecisions(
      actionRequests as ActionRequest[],
      serverDecisions,
      autoApprove
    );
    if (decisions === null) return;
    if (serverResolvedRef.current.has(key)) return;
    if (serverDecisions !== null) serverResolvedRef.current.add(key);
    else if (approvedIdsRef.current.has(key)) return;
    approvedIdsRef.current.add(key);
    resumeInterrupt(buildToolApprovalResume(interruptIdOf(ir), { decisions }));
  }, [
    autoApprove,
    interrupt,
    resumeInterrupt,
    isLoading,
    resetKey,
    policyKey,
    policyChecking,
    policyDecisions,
  ]);
}
