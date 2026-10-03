/**
 * An agent-state file's value as text. Usually a string; some backends store
 * `{ content: string[] }` (one entry per line).
 */
export function stateFileText(raw: unknown): string {
  if (typeof raw === "object" && raw !== null && "content" in raw) {
    const content = (raw as { content: unknown }).content;
    return Array.isArray(content) ? content.join("\n") : String(content ?? "");
  }
  return String(raw ?? "");
}
