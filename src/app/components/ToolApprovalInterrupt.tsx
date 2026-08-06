"use client";

import { useId, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, Check, X, Pencil } from "lucide-react";
import type { ActionRequest, ReviewConfig } from "@/app/types/types";
import { cn } from "@/lib/utils";
import { stringifyUnknown } from "@/app/utils/utils";

interface ToolApprovalInterruptProps {
  actionRequest: ActionRequest;
  reviewConfig?: ReviewConfig;
  onResume: (value: any) => void;
  /**
   * Abandon the whole run — the Reject path. Unlike Approve/Edit (which submit a
   * decision through `onResume`), rejecting no longer sends a `{type:"reject"}`
   * decision: that produced a `ToolMessage` the agent misread as tool stdout.
   * Instead it stops the run and hands control back to the composer, matching the
   * TUI. A whole-run action, so no per-decision payload.
   */
  onAbort?: () => void;
  isLoading?: boolean;
  onSubmitted?: () => void;
}

function argsToRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object"
    ? (args as Record<string, unknown>)
    : {};
}

function cloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(stringifyUnknown(args)) as Record<string, unknown>;
  } catch {
    return { ...args };
  }
}

function formatValue(value: unknown): string {
  return stringifyUnknown(value);
}

export function ToolApprovalInterrupt({
  actionRequest,
  reviewConfig,
  onResume,
  onAbort,
  isLoading,
  onSubmitted,
}: ToolApprovalInterruptProps) {
  const editArgIdPrefix = useId();
  const approvalRegionLabel = `Approval required for ${actionRequest.name}`;
  const [isEditing, setIsEditing] = useState(false);
  const [editedArgs, setEditedArgs] = useState<Record<string, unknown>>({});
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const actionArgs = useMemo(
    () => argsToRecord(actionRequest.args),
    [actionRequest.args]
  );
  const normalizedDescription = actionRequest.description?.toLowerCase() ?? "";
  const descriptionIsRedundant =
    normalizedDescription.includes(
      `tool: ${actionRequest.name.toLowerCase()}`
    ) && normalizedDescription.includes("args:");
  const allowedDecisions = reviewConfig?.allowedDecisions ??
    reviewConfig?.allowed_decisions ?? ["approve", "reject", "edit"];

  const submitDecision = (value: any) => {
    flushSync(() => {
      setSubmitted(true);
      if (onSubmitted) {
        onSubmitted();
      }
    });
    onResume(value);
  };

  const handleApprove = () => {
    submitDecision({
      decisions: [{ type: "approve" }],
    });
  };

  const handleReject = () => {
    // Abandon the run instead of submitting a reject decision. Hide the card the
    // same way submitDecision does (so it can't be clicked twice), then abort.
    flushSync(() => {
      setSubmitted(true);
      if (onSubmitted) {
        onSubmitted();
      }
    });
    onAbort?.();
  };

  const handleEdit = () => {
    if (isEditing) {
      submitDecision({
        decisions: [
          {
            type: "edit",
            edited_action: {
              name: actionRequest.name,
              args: editedArgs,
            },
          },
        ],
      });
      setIsEditing(false);
      setEditedArgs({});
    }
  };

  const startEditing = () => {
    setIsEditing(true);
    setEditedArgs(cloneArgs(actionArgs));
    setEditErrors({});
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditedArgs({});
    setEditErrors({});
  };

  const updateEditedArg = (key: string, value: string, original: unknown) => {
    if (typeof original === "string") {
      setEditedArgs((prev) => ({ ...prev, [key]: value }));
      setEditErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    try {
      const parsedValue = JSON.parse(value);
      setEditedArgs((prev) => ({ ...prev, [key]: parsedValue }));
      setEditErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch {
      setEditedArgs((prev) => ({ ...prev, [key]: value }));
      setEditErrors((prev) => ({
        ...prev,
        [key]: "Enter valid JSON to preserve this argument's value type.",
      }));
    }
  };

  if (submitted) {
    return null;
  }

  return (
    <section
      aria-label={approvalRegionLabel}
      className="w-full rounded-md border border-border bg-muted/30 p-3 sm:p-4"
    >
      {/* Header */}
      <div className="mb-3 flex items-center gap-2 text-foreground">
        <AlertCircle
          size={16}
          className="text-yellow-600 dark:text-yellow-400"
          aria-hidden="true"
        />
        <span className="text-xs font-semibold uppercase tracking-wider">
          Approval Required
        </span>
      </div>

      {/* Description */}
      {actionRequest.description && !descriptionIsRedundant && (
        <p className="mb-3 text-sm text-muted-foreground">
          {actionRequest.description}
        </p>
      )}

      {actionRequest.name === "delete" && (
        <p className="mb-3 text-sm font-medium text-destructive">
          Recursive filesystem delete. Review the target carefully.
        </p>
      )}
      {actionRequest.name === "schedule_task" && (
        <p className="mb-3 text-sm text-muted-foreground">
          Creates a scheduled task that runs on its own later. Never
          auto-approved.
        </p>
      )}

      {/* Tool Info Card */}
      <div className="mb-4 rounded-sm border border-border bg-background p-2.5 sm:p-3">
        <div className="mb-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Tool
          </span>
          <p className="mt-1 font-mono text-sm font-medium text-foreground">
            {actionRequest.name}
          </p>
        </div>

        {isEditing ? (
          <div>
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Edit Arguments
            </span>
            <div className="mt-2 space-y-3">
              {Object.entries(actionArgs).map(([key, value]) => (
                <div key={key}>
                  <label
                    htmlFor={`${editArgIdPrefix}-edit-arg-${key}`}
                    className="mb-1 block text-xs font-medium text-foreground"
                  >
                    {key}
                  </label>
                  <Textarea
                    id={`${editArgIdPrefix}-edit-arg-${key}`}
                    value={
                      editedArgs[key] !== undefined
                        ? typeof editedArgs[key] === "string"
                          ? (editedArgs[key] as string)
                          : formatValue(editedArgs[key])
                        : typeof value === "string"
                        ? value
                        : formatValue(value)
                    }
                    onChange={(e) =>
                      updateEditedArg(key, e.target.value, value)
                    }
                    className="font-mono text-xs"
                    rows={
                      typeof value === "string" && value.length < 100 ? 2 : 4
                    }
                    disabled={isLoading}
                    aria-invalid={editErrors[key] ? true : undefined}
                    aria-describedby={
                      editErrors[key]
                        ? `${editArgIdPrefix}-edit-arg-${key}-error`
                        : undefined
                    }
                  />
                  {editErrors[key] && (
                    <p
                      id={`${editArgIdPrefix}-edit-arg-${key}-error`}
                      className="mt-1 text-xs text-destructive"
                    >
                      {editErrors[key]}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Arguments
            </span>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-muted/40 p-2 font-mono text-xs text-foreground">
              {formatValue(actionArgs)}
            </pre>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {isEditing ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={cancelEditing}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleEdit}
              disabled={isLoading || Object.keys(editErrors).length > 0}
              className="bg-green-600 text-white hover:bg-green-700 dark:bg-green-600 dark:hover:bg-green-700"
            >
              <Check
                size={14}
                aria-hidden="true"
              />
              {isLoading ? "Saving…" : "Save & Approve"}
            </Button>
          </>
        ) : (
          <>
            {allowedDecisions.includes("reject") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleReject}
                disabled={isLoading}
                className="text-destructive hover:bg-destructive/10"
              >
                <X
                  size={14}
                  aria-hidden="true"
                />
                Reject
              </Button>
            )}
            {allowedDecisions.includes("edit") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={startEditing}
                disabled={isLoading}
              >
                <Pencil
                  size={14}
                  aria-hidden="true"
                />
                Edit
              </Button>
            )}
            {allowedDecisions.includes("approve") && (
              <Button
                type="button"
                size="sm"
                onClick={handleApprove}
                disabled={isLoading}
                className={cn(
                  "bg-green-600 text-white hover:bg-green-700",
                  "dark:bg-green-600 dark:hover:bg-green-700"
                )}
              >
                <Check
                  size={14}
                  aria-hidden="true"
                />
                {isLoading ? "Approving…" : "Approve"}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
