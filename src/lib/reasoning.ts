export interface Reasoning {
  text: string;
  /** Only OpenAI's summaries are written in Markdown. */
  markdown: boolean;
}

/**
 * A message's reasoning text. OpenAI-compatible routes (DeepSeek, OpenRouter)
 * put it in `reasoning_content`; Anthropic in `thinking` blocks; OpenAI's
 * Responses API in `reasoning` blocks as summary_text parts (langchain's
 * standard block as a `reasoning` string). Like the backend CLI, the blocks
 * are read only when the field is empty. Only OpenAI's summaries are written
 * in Markdown; the rest is plain scratch text and shows as written.
 */
export function messageReasoning(message: {
  additional_kwargs?: unknown;
  content?: unknown;
}): Reasoning | null {
  const r = (message.additional_kwargs as Record<string, unknown> | undefined)
    ?.reasoning_content;
  if (typeof r === "string" && r.trim()) {
    return { text: r.trim(), markdown: false };
  }
  const parts: Reasoning[] = [];
  const add = (text: unknown, markdown: boolean) => {
    if (typeof text === "string" && text.trim()) {
      parts.push({ text: text.trim(), markdown });
    }
  };
  if (Array.isArray(message.content)) {
    for (const block of message.content as unknown[]) {
      const b = block as {
        type?: unknown;
        thinking?: unknown;
        reasoning?: unknown;
        summary?: unknown;
      } | null;
      if (b?.type === "thinking") add(b.thinking, false);
      if (b?.type === "reasoning") {
        add(b.reasoning, false);
        if (Array.isArray(b.summary)) {
          for (const part of b.summary as {
            type?: unknown;
            text?: unknown;
          }[]) {
            if (part?.type === "summary_text") add(part.text, true);
          }
        }
      }
    }
  }
  if (parts.length === 0) return null;
  return {
    text: parts.map((p) => p.text).join("\n\n"),
    markdown: parts.every((p) => p.markdown),
  };
}
