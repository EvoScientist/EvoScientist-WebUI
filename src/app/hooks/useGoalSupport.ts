"use client";

import { useEffect, useState } from "react";
import type { Client } from "@langchain/langgraph-sdk";
import { retryWithBackoff } from "@/lib/retry";
import { getHttpStatus } from "@/lib/streamError";
import { CHAT_GRAPH_ID } from "@/lib/workspaceAssistant";
import { assistantIdFor } from "@/lib/workspaceSession";
import { useClient } from "@/providers/ClientProvider";
import { useWorkspace } from "@/providers/WorkspaceProvider";

function takesGoalRequest(schemas: unknown): boolean {
  const input = (schemas as { input_schema?: { properties?: unknown } } | null)
    ?.input_schema;
  const properties = input?.properties;
  return (
    !!properties &&
    typeof properties === "object" &&
    "goal_request" in properties
  );
}

/**
 * Whether the backend's main graph takes a /goal request: its input schema
 * has `goal_request` (core v0.3.7 and later). Undefined until known.
 * getSchemas takes only an assistant UUID, the folder's workspace assistant;
 * a legacy core is asked by graph name and refuses (422), and has no goal
 * either, so that refusal reads as false. Anything else (no answer, a 5xx,
 * a 404, 408 or 429) leaves it unknown, which still marks every run, and is
 * asked again: a
 * goal review reloaded during a blip keeps its marker. The answer belongs to
 * the client it came from (one per deployment) and the assistant it asked: a
 * switch resets it during render.
 */
export function useGoalSupport(): boolean | undefined {
  const client = useClient();
  const { workspace } = useWorkspace();
  const assistantId = assistantIdFor(workspace, CHAT_GRAPH_ID);
  const [loaded, setLoaded] = useState<{
    client: Client;
    assistantId: string | null;
    supported: boolean | undefined;
  }>({ client, assistantId, supported: undefined });
  const current =
    loaded.client === client && loaded.assistantId === assistantId;
  if (!current) {
    setLoaded({ client, assistantId, supported: undefined });
  }

  useEffect(() => {
    if (!assistantId) return;
    const controller = new AbortController();
    let refused = false;
    void retryWithBackoff(
      async () => client.assistants.getSchemas(assistantId),
      controller.signal,
      10_000,
      (error) => {
        const status = getHttpStatus(error);
        // Only a malformed question is refused for good: a legacy core
        // answers a graph name with 422. A 404 (assistant not made yet), a
        // 408 or a 429 can pass.
        refused = status === 400 || status === 422;
        return refused ? false : undefined;
      }
    ).then((schemas) => {
      if (controller.signal.aborted) return;
      if (schemas === null && !refused) return;
      setLoaded({
        client,
        assistantId,
        supported: schemas !== null && takesGoalRequest(schemas),
      });
    });
    return () => controller.abort();
  }, [client, assistantId]);

  return current ? loaded.supported : undefined;
}
