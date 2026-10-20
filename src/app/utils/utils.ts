import type { Message } from "@langchain/langgraph-sdk";

export function stringifyUnknown(value: unknown, space = 2): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";

  try {
    // Track the ancestor chain rather than every object already visited: the
    // same object appearing twice as a sibling is repetition, not a cycle.
    // The replacer's `this` is the object the current key belongs to, which
    // is what lets us unwind back to the right depth.
    const ancestors: object[] = [];
    const serialized = JSON.stringify(
      value,
      function (this: unknown, _key, nestedValue) {
        if (typeof nestedValue === "bigint") {
          return nestedValue.toString();
        }
        if (nestedValue && typeof nestedValue === "object") {
          while (
            ancestors.length > 0 &&
            ancestors[ancestors.length - 1] !== this
          ) {
            ancestors.pop();
          }
          if (ancestors.includes(nestedValue)) return "[Circular]";
          ancestors.push(nestedValue);
        }
        return nestedValue;
      },
      space
    );
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

export function extractStringFromMessageContent(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
    ? message.content
        .filter(
          (c: unknown) =>
            (typeof c === "object" &&
              c !== null &&
              "type" in c &&
              (c as { type: string }).type === "text") ||
            typeof c === "string"
        )
        .map((c: unknown) =>
          typeof c === "string"
            ? c
            : typeof c === "object" && c !== null && "text" in c
            ? (c as { text?: string }).text || ""
            : ""
        )
        .join("")
    : "";
}

function parseToolArgs(rawArgs: unknown): Record<string, unknown> {
  if (rawArgs && typeof rawArgs === "object") {
    return rawArgs as Record<string, unknown>;
  }
  if (typeof rawArgs !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(rawArgs);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function getMessageToolCalls(message: Message): Array<{
  id?: string;
  name: string;
  args: Record<string, unknown>;
}> {
  const messageWithTools = message as Message & {
    tool_calls?: Array<{ name?: string } | null>;
  };
  const toolCalls: Array<{
    id?: string;
    function?: { name?: string; arguments?: unknown };
    name?: string;
    type?: string;
    args?: unknown;
    input?: unknown;
  } | null> = [];

  // A malformed message can hold null or other non-object entries; a list of
  // nothing else isn't where its calls are, but an empty one still is.
  const holdsCalls = (list: unknown[]) =>
    list.length === 0 ||
    list.some((entry) => typeof entry === "object" && entry !== null);

  if (
    message.additional_kwargs?.tool_calls &&
    Array.isArray(message.additional_kwargs.tool_calls) &&
    holdsCalls(message.additional_kwargs.tool_calls)
  ) {
    toolCalls.push(...message.additional_kwargs.tool_calls);
  } else if (
    messageWithTools.tool_calls &&
    Array.isArray(messageWithTools.tool_calls) &&
    holdsCalls(messageWithTools.tool_calls)
  ) {
    toolCalls.push(
      ...messageWithTools.tool_calls.filter(
        (toolCall: { name?: string } | null) => toolCall?.name !== ""
      )
    );
  } else if (Array.isArray(message.content)) {
    toolCalls.push(
      ...message.content.filter(
        (block: { type?: string } | null) => block?.type === "tool_use"
      )
    );
  }

  // Reading a null entry in additional_kwargs.tool_calls blanked the chat.
  return toolCalls.flatMap((toolCall) => {
    if (typeof toolCall !== "object" || toolCall === null) return [];
    const rawArgs =
      toolCall.function?.arguments || toolCall.args || toolCall.input || {};
    return [
      {
        id: toolCall.id,
        name: toolCall.function?.name || toolCall.name || toolCall.type || "",
        args: parseToolArgs(rawArgs),
      },
    ];
  });
}

export function extractSubAgentContent(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  if (data && typeof data === "object") {
    const dataObj = data as Record<string, unknown>;

    // An empty string must not win over the later fallbacks, or a task whose
    // `description` is blank renders nothing instead of its `prompt`.
    const firstNonEmpty = (key: string): string | null => {
      const candidate = dataObj[key];
      return typeof candidate === "string" && candidate.trim() !== ""
        ? candidate
        : null;
    };

    // Try to extract description first
    const description = firstNonEmpty("description");
    if (description !== null) return description;

    // Then try prompt
    const prompt = firstNonEmpty("prompt");
    if (prompt !== null) return prompt;

    // For output objects, try result
    const result = firstNonEmpty("result");
    if (result !== null) return result;

    // Fallback to JSON stringification
    return stringifyUnknown(data);
  }

  // Fallback for any other type
  return stringifyUnknown(data);
}
