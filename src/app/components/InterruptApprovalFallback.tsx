"use client";

import { useEffect, useMemo, useRef } from "react";
import { Bot } from "lucide-react";
import { ToolApprovalInterrupt } from "@/app/components/ToolApprovalInterrupt";
import type { ActionRequest, ReviewConfig } from "@/app/types/types";
import type { Decision } from "@/lib/hitl";
import { stringifyUnknown } from "@/app/utils/utils";

interface InterruptApprovalFallbackProps {
  actionRequests: ActionRequest[];
  reviewConfigsMap: Map<string, ReviewConfig>;
  requestedBy?: string | null;
  interruptKey?: string;
  onResume: (value: { decisions: Decision[] }) => void;
  /** Abandon the run — the Reject path. See ToolApprovalInterrupt.onAbort. */
  onAbort?: () => void;
  isLoading?: boolean;
}

export function InterruptApprovalFallback({
  actionRequests,
  reviewConfigsMap,
  requestedBy,
  interruptKey,
  onResume,
  onAbort,
  isLoading,
}: InterruptApprovalFallbackProps) {
  const pendingDecisionsRef = useRef<Record<number, Decision>>({});

  const actionRequestsKey = useMemo(
    () =>
      stringifyUnknown(
        actionRequests.map((ar) => ({ name: ar.name, args: ar.args })),
        0
      ),
    [actionRequests]
  );

  useEffect(() => {
    pendingDecisionsRef.current = {};
  }, [actionRequestsKey, interruptKey]);

  const handleResume = (actionIndex: number, value: unknown) => {
    const decisions = (value as { decisions?: Decision[] } | undefined)
      ?.decisions;
    if (!Array.isArray(decisions) || decisions.length === 0) return;
    if (
      actionRequests.length === 1 ||
      decisions.length === actionRequests.length
    ) {
      onResume({ decisions });
      return;
    }
    const next = {
      ...pendingDecisionsRef.current,
      [actionIndex]: decisions[0],
    };
    pendingDecisionsRef.current = next;
    if (!actionRequests.every((_, index) => next[index])) return;
    pendingDecisionsRef.current = {};
    onResume({ decisions: actionRequests.map((_, index) => next[index]) });
  };

  return (
    <div className="mt-4 flex w-full flex-col gap-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Bot
          size={14}
          aria-hidden="true"
        />
        {requestedBy
          ? `Approval requested by ${requestedBy}`
          : "Approval requested by a sub-agent"}
      </div>
      {actionRequests.map((actionRequest, index) => (
        <ToolApprovalInterrupt
          key={`${interruptKey ?? actionRequestsKey}-${index}-${
            actionRequest.name
          }`}
          actionRequest={actionRequest}
          reviewConfig={reviewConfigsMap.get(actionRequest.name)}
          onResume={(value) => handleResume(index, value)}
          onAbort={onAbort}
          isLoading={isLoading}
        />
      ))}
    </div>
  );
}
