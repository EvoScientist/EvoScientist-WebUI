// Pinned skills.
//
// When a user message starts with `/skill-name`, the backend appends a second
// HUMAN message right after it that carries the skill's SKILL.md, tagged:
//
//   additional_kwargs: {
//     lc_source: "pinned_skill",
//     skill: { name, path, description },
//   }
//
// The content is `<skill name="…" path="…">\n{SKILL.md body}\n</skill>`
// (frontmatter already stripped). That message is context for the model, not
// something the user typed, so the chat shows a collapsed `Skill · <name>` row
// that opens to the description and the body instead of a bubble.

import type { Message } from "@langchain/langgraph-sdk";

/**
 * The skill name of a pinned-skill message, `"unknown"` when the marker is
 * there but carries no usable name, or null for every other message.
 */
export function pinnedSkillName(message: Message): string | null {
  if (message.type !== "human") return null;
  const ak = (message as { additional_kwargs?: Record<string, unknown> })
    .additional_kwargs;
  if (ak?.["lc_source"] !== "pinned_skill") return null;
  const skill = ak["skill"];
  const name =
    skill && typeof skill === "object"
      ? (skill as Record<string, unknown>)["name"]
      : undefined;
  return typeof name === "string" && name ? name : "unknown";
}

/**
 * The SKILL.md body without the `<skill …>` wrapper the backend adds. Content
 * that does not carry the wrapper is returned as is.
 */
export function pinnedSkillBody(content: string): string {
  // The backend writes `<skill …>\n{body}\n</skill>`; matching that exact
  // shape keeps the first line's indentation and stays linear on long blank
  // runs, which a lazy `\s*` around the body does not.
  const wrapped = content.match(
    /^\s*<skill\b[^>]*>\r?\n([\s\S]*)\r?\n<\/skill>\s*$/
  );
  return wrapped ? wrapped[1] : content;
}

/** The skill's one-line description from the marker, or null when unusable. */
export function pinnedSkillDescription(message: Message): string | null {
  const ak = (message as { additional_kwargs?: Record<string, unknown> })
    .additional_kwargs;
  const skill = ak?.["skill"];
  const description =
    skill && typeof skill === "object"
      ? (skill as Record<string, unknown>)["description"]
      : undefined;
  return typeof description === "string" && description.trim()
    ? description.trim()
    : null;
}
