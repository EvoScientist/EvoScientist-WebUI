export interface ActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

export type Decision =
  | { type: "approve" }
  | {
      type: "edit";
      edited_action: { name: string; args: Record<string, unknown> };
    }
  | { type: "reject"; message?: string }
  | { type: "respond"; message: string };

export interface HITLResponse {
  decisions: Decision[];
}

export function buildToolApprovalResume(
  interruptId: string | undefined,
  response: HITLResponse
): unknown {
  if (interruptId) return { [interruptId]: response };
  return response;
}

export function interruptIdOf(interrupt: unknown): string | undefined {
  if (!interrupt || typeof interrupt !== "object") return undefined;
  const id = (interrupt as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export interface BindableToolCall {
  id: string;
  name: string;
  status: string;
}

export interface BoundActionRequest {
  actionRequest: ActionRequest;
  actionIndex: number;
}

export function bindActionRequestsToToolCalls(
  toolCalls: BindableToolCall[],
  actionRequests: ActionRequest[]
): Map<string, BoundActionRequest> {
  const out = new Map<string, BoundActionRequest>();
  if (actionRequests.length === 0) return out;
  const queues = new Map<string, BoundActionRequest[]>();
  actionRequests.forEach((actionRequest, actionIndex) => {
    const entry = { actionRequest, actionIndex };
    const list = queues.get(actionRequest.name);
    if (list) list.push(entry);
    else queues.set(actionRequest.name, [entry]);
  });
  const cursor = new Map<string, number>();
  for (const tc of toolCalls) {
    if (tc.status !== "interrupted") continue;
    const list = queues.get(tc.name);
    if (!list) continue;
    const i = cursor.get(tc.name) ?? 0;
    if (i < list.length) {
      out.set(tc.id, list[i]);
      cursor.set(tc.name, i + 1);
    }
  }
  return out;
}
