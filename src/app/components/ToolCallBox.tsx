"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import {
  ChevronDown,
  ChevronUp,
  Terminal,
  AlertCircle,
  Loader2,
  CircleCheckBigIcon,
  StopCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolCall, ActionRequest, ReviewConfig } from "@/app/types/types";
import { cn } from "@/lib/utils";
import { LoadExternalComponent } from "@langchain/langgraph-sdk/react-ui";
import { ToolApprovalInterrupt } from "@/app/components/ToolApprovalInterrupt";
import { formatToolLabel } from "@/lib/toolLabel";

interface ToolCallBoxProps {
  toolCall: ToolCall;
  uiComponent?: any;
  stream?: any;
  graphId?: string;
  actionRequest?: ActionRequest;
  actionRequestKey?: string;
  actionRequestSubmitted?: boolean;
  onActionRequestSubmitted?: (key: string) => void;
  reviewConfig?: ReviewConfig;
  onResume?: (value: any) => void;
  isLoading?: boolean;
  autoApprove?: boolean;
}

export const ToolCallBox = React.memo<ToolCallBoxProps>(
  ({
    toolCall,
    uiComponent,
    stream,
    graphId,
    actionRequest,
    actionRequestKey: externalActionRequestKey,
    actionRequestSubmitted,
    onActionRequestSubmitted,
    reviewConfig,
    onResume,
    isLoading,
    autoApprove,
  }) => {
    const [isExpanded, setIsExpanded] = useState(
      () => !!uiComponent || (!!actionRequest && !autoApprove)
    );
    const [expandedArgs, setExpandedArgs] = useState<Record<string, boolean>>(
      {}
    );
    const fallbackActionRequestKey = useMemo(() => {
      if (!actionRequest) return null;
      return `${toolCall.id}:${actionRequest.name}:${JSON.stringify(
        actionRequest.args
      )}`;
    }, [actionRequest, toolCall.id]);
    const actionRequestKey =
      externalActionRequestKey ?? fallbackActionRequestKey;
    const [submittedActionRequestKey, setSubmittedActionRequestKey] = useState<
      string | null
    >(null);

    useEffect(() => {
      if (!actionRequestKey) {
        setSubmittedActionRequestKey(null);
        return;
      }
      setSubmittedActionRequestKey((current) =>
        current && current !== actionRequestKey ? null : current
      );
    }, [actionRequestKey]);

    // Generative UI: expand to show it.
    useEffect(() => {
      if (uiComponent) setIsExpanded(true);
    }, [uiComponent]);

    // Approval lifecycle: expand when an approval appears (skip if auto-approve
    // is on), and collapse again once it's resolved.
    const prevActionRequestRef = useRef(actionRequest);
    useEffect(() => {
      const had = !!prevActionRequestRef.current;
      const has = !!actionRequest;
      if (has && !had && !autoApprove) setIsExpanded(true);
      else if (!has && had) setIsExpanded(false);
      prevActionRequestRef.current = actionRequest;
    }, [actionRequest, autoApprove]);

    const { name, args, result, status } = useMemo(() => {
      // Streaming can deliver args as a (possibly partial) JSON string, not an
      // object — treat it as `unknown` and only expose a real object to the
      // args view, so Object.keys/entries never run on a string.
      const rawArgs: unknown = toolCall.args;
      return {
        // Targeted label overrides only (read_file/write_file/edit_file on
        // /memories → "Reading memory"/"Updating memory", think_tool →
        // "Reflection"); every other tool keeps its raw name.
        name: formatToolLabel(toolCall.name, rawArgs),
        args:
          rawArgs && typeof rawArgs === "object"
            ? (rawArgs as Record<string, unknown>)
            : {},
        result: toolCall.result,
        status: toolCall.status || "completed",
      };
    }, [toolCall]);

    const statusIcon = useMemo(() => {
      switch (status) {
        case "completed":
          return <CircleCheckBigIcon />;
        case "error":
          return (
            <AlertCircle
              size={14}
              className="text-destructive"
            />
          );
        case "pending":
          return (
            <Loader2
              size={14}
              className="animate-spin"
            />
          );
        case "interrupted":
          return (
            <StopCircle
              size={14}
              className="text-orange-500"
            />
          );
        default:
          return (
            <Terminal
              size={14}
              className="text-muted-foreground"
            />
          );
      }
    }, [status]);

    const toggleExpanded = useCallback(() => {
      setIsExpanded((prev) => !prev);
    }, []);

    const toggleArgExpanded = useCallback((argKey: string) => {
      setExpandedArgs((prev) => ({
        ...prev,
        [argKey]: !prev[argKey],
      }));
    }, []);

    const hasContent = result || Object.keys(args).length > 0;
    const isActionRequestSubmitted =
      actionRequestSubmitted ?? submittedActionRequestKey === actionRequestKey;
    const showApproval =
      actionRequest &&
      onResume &&
      (!actionRequestKey || !isActionRequestSubmitted);

    return (
      <div
        className={cn(
          "w-full overflow-hidden rounded-lg border-none shadow-none outline-none transition-colors duration-200 focus-within:ring-2 focus-within:ring-ring hover:bg-accent",
          isExpanded && hasContent && "bg-accent"
        )}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleExpanded}
          className={cn(
            "flex w-full items-center justify-between gap-2 border-none px-2 py-2 text-left shadow-none outline-none disabled:cursor-default"
          )}
          disabled={!hasContent}
        >
          <div className="flex w-full items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {statusIcon}
              <span className="text-[15px] font-medium tracking-[-0.6px] text-foreground">
                {name}
              </span>
            </div>
            {hasContent &&
              (isExpanded ? (
                <ChevronUp
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
              ) : (
                <ChevronDown
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
              ))}
          </div>
        </Button>

        {isExpanded && hasContent && (
          <div className="px-4 pb-4">
            {uiComponent && stream && graphId ? (
              <div className="mt-4">
                <LoadExternalComponent
                  key={uiComponent.id}
                  stream={stream}
                  message={uiComponent}
                  namespace={graphId}
                  meta={{ status, args, result: result ?? "No Result Yet" }}
                />
              </div>
            ) : showApproval ? (
              // Show tool approval UI when there's an action request but no GenUI
              <div className="mt-4">
                <ToolApprovalInterrupt
                  actionRequest={actionRequest}
                  reviewConfig={reviewConfig}
                  onResume={onResume}
                  isLoading={isLoading}
                  onSubmitted={() => {
                    setSubmittedActionRequestKey(actionRequestKey);
                    if (actionRequestKey) {
                      onActionRequestSubmitted?.(actionRequestKey);
                    }
                    setIsExpanded(false);
                  }}
                />
              </div>
            ) : (
              <>
                {Object.keys(args).length > 0 && (
                  <div className="mt-4">
                    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Arguments
                    </h4>
                    <div className="space-y-2">
                      {Object.entries(args).map(([key, value]) => (
                        <div
                          key={key}
                          className="rounded-sm border border-border"
                        >
                          <button
                            type="button"
                            onClick={() => toggleArgExpanded(key)}
                            className="flex w-full items-center justify-between bg-muted/30 p-2 text-left text-xs font-medium transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            <span className="font-mono">{key}</span>
                            {expandedArgs[key] ? (
                              <ChevronUp
                                size={12}
                                className="text-muted-foreground"
                              />
                            ) : (
                              <ChevronDown
                                size={12}
                                className="text-muted-foreground"
                              />
                            )}
                          </button>
                          {expandedArgs[key] && (
                            <div className="border-t border-border bg-muted/20 p-2">
                              <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-6 text-foreground">
                                {typeof value === "string"
                                  ? value
                                  : JSON.stringify(value, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {result && (
                  <div className="mt-4">
                    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Result
                    </h4>
                    <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-muted/40 p-2 font-mono text-xs leading-7 text-foreground">
                      {typeof result === "string"
                        ? result
                        : JSON.stringify(result, null, 2)}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  }
);

ToolCallBox.displayName = "ToolCallBox";
