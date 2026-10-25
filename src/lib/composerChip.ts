// The composer's chip: the skill a message's first word pins, or the goal
// mode the `/` menu put the composer in. The composer still holds one string
// (what is sent, queued and handed back); a chip stands for its start, the
// lead, and the box shows the rest.

import { parseGoalCommand } from "./goalCommand";
import { PY_SPACE } from "./pythonWhitespace";
import { PIN_WORD } from "./slashMenu";

export type GoalMode = "goal" | "amend";

export type ComposerChip =
  | { kind: "skill"; name: string }
  | { kind: "goal" }
  | { kind: "amend" };

export interface ComposerLead {
  chip: ComposerChip | null;
  /** The start of the text the chip stands for ("" without a chip). */
  lead: string;
}

/** What a goal mode's text starts with. */
export const GOAL_LEADS: Record<GoalMode, string> = {
  goal: "/goal ",
  amend: "/goal amend ",
};

const NONE: ComposerLead = { chip: null, lead: "" };
const COMMANDS: ReadonlySet<string> = new Set(["model", "goal"]);
// A pin is `/` and at most 64 characters (slashTokenAt's bound): a long
// paste is never scanned further.
const MAX_WORD = 65;

/** The installed skill a text's first word pins, with the one whitespace
 *  after it: once the word is whole, and never a command's word. */
function skillLead(
  text: string,
  skills: ReadonlySet<string> | null,
  commands: ReadonlySet<string>
): ComposerLead {
  if (!skills || text[0] !== "/") return NONE;
  let end = 1;
  while (end < text.length && !PY_SPACE.test(text[end])) {
    if (end >= MAX_WORD) return NONE;
    end++;
  }
  if (end === text.length) return NONE;
  const word = text.slice(0, end);
  const name = word.slice(1);
  if (!PIN_WORD.test(word) || commands.has(name) || !skills.has(name)) {
    return NONE;
  }
  return { chip: { kind: "skill", name }, lead: text.slice(0, end + 1) };
}

/** The chip for the composer's text: its goal mode while the text starts
 *  with the mode's lead (only the menu sets a mode; a typed "/goal …" stays
 *  text), else an installed skill its first word pins. */
export function composerLead(
  text: string,
  {
    skills,
    goalMode,
    commands = COMMANDS,
  }: {
    skills: ReadonlySet<string> | null;
    goalMode: GoalMode | null;
    /** Words that are commands, never skills (/goal only where it runs). */
    commands?: ReadonlySet<string>;
  }
): ComposerLead {
  if (goalMode && text.startsWith(GOAL_LEADS[goalMode])) {
    return { chip: { kind: goalMode }, lead: GOAL_LEADS[goalMode] };
  }
  return skillLead(text, skills, commands);
}

/** Where a goal command's own text starts: past "/goal", "amend" for an
 *  amend, and the whitespace after each. */
function goalTextStart(text: string, amend: boolean): number {
  let i = 0;
  const spaces = () => {
    while (i < text.length && PY_SPACE.test(text[i])) i++;
  };
  spaces();
  i += "/goal".length;
  spaces();
  if (amend) {
    i += "amend".length;
    spaces();
  }
  return i;
}

/** How a sent or queued text reads: the goal it sets or amends, read as
 *  Enter reads it (where goals run), else its skill. */
export function previewLead(
  text: string,
  {
    skills,
    goals,
  }: {
    skills: ReadonlySet<string> | null;
    goals: boolean;
  }
): ComposerLead {
  if (goals) {
    const command = parseGoalCommand(text);
    if (command?.kind === "create" || command?.kind === "amend") {
      const amend = command.kind === "amend";
      return {
        chip: { kind: command.kind === "create" ? "goal" : "amend" },
        lead: text.slice(0, goalTextStart(text, amend)),
      };
    }
  }
  return skillLead(text, skills, goals ? COMMANDS : new Set(["model"]));
}

/** How a sent message reads: the skills the backend pinned for it (the
 *  markers after it, in order) while they lead its text, and the rest. A
 *  word that isn't the next pin ends the chips; without any the text stays
 *  as it is. */
export function pinnedLead(
  text: string,
  pinned: readonly string[]
): { skills: string[]; rest: string } {
  const skills: string[] = [];
  let at = 0;
  const spaces = () => {
    while (at < text.length && PY_SPACE.test(text[at])) at++;
  };
  spaces();
  let restAt = 0;
  for (const name of pinned) {
    const word = `/${name}`;
    const end = at + word.length;
    if (
      text.slice(at, end) !== word ||
      (end < text.length && !PY_SPACE.test(text[end]))
    ) {
      break;
    }
    skills.push(name);
    at = end;
    spaces();
    restAt = at;
  }
  return { skills, rest: text.slice(restAt) };
}
