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
// A pin is `/` and at most 64 characters (slashTokenAt's bound), and the
// whitespace ahead of it is read up to 1,024 characters: the lead is read
// every render, and a pasted log is never scanned further (a million blank
// lines cost 12 ms a call).
const MAX_WORD = 65;
const MAX_SPACE = 1024;

/** The index past the whitespace at `at`, read up to MAX_SPACE characters
 *  (-1 beyond). */
function pastSpace(text: string, at: number): number {
  let i = at;
  while (i < text.length && PY_SPACE.test(text[i])) {
    if (i - at >= MAX_SPACE) return -1;
    i++;
  }
  return i;
}

/** Whether a text's first word (after whitespace, as the backend splits
 *  it) starts with "/": it may pin a skill, so the skill names are wanted. */
export function mayPin(text: string): boolean {
  const at = pastSpace(text, 0);
  return at >= 0 && text[at] === "/";
}

/** A text's leading "/word" as a pin takes it, whatever is installed: the
 *  whitespace ahead of it, the word and the one whitespace after it, once
 *  the word is whole; never a command's word. The text goes out trimmed and
 *  the backend splits it on whitespace, so a pin after leading whitespace
 *  pins too. */
export function pinLead(
  text: string,
  commands: ReadonlySet<string> = COMMANDS
): { name: string; lead: string } | null {
  const start = pastSpace(text, 0);
  if (start < 0 || text[start] !== "/") return null;
  let end = start + 1;
  while (end < text.length && !PY_SPACE.test(text[end])) {
    if (end - start >= MAX_WORD) return null;
    end++;
  }
  if (end === text.length) return null;
  const word = text.slice(start, end);
  const name = word.slice(1);
  if (!PIN_WORD.test(word) || commands.has(name)) return null;
  return { name, lead: text.slice(0, end + 1) };
}

/** The installed skill a text's first word pins (pinLead's, when that word
 *  is an installed skill). */
function skillLead(
  text: string,
  skills: ReadonlySet<string> | null,
  commands: ReadonlySet<string>
): ComposerLead {
  const pin = skills ? pinLead(text, commands) : null;
  if (!pin || !skills!.has(pin.name)) return NONE;
  return { chip: { kind: "skill", name: pin.name }, lead: pin.lead };
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

/** One skill a message: while the text after a skill's lead starts with
 *  another skill's, the earlier one goes, so the last of several leading
 *  skills stays (as a pick or a skill typed over the chip replaces it).
 *  A goal mode's text is left as it is. */
export function oneSkill(
  text: string,
  options: {
    skills: ReadonlySet<string> | null;
    goalMode: GoalMode | null;
    commands?: ReadonlySet<string>;
  }
): string {
  let out = text;
  for (;;) {
    const first = composerLead(out, options);
    if (first.chip?.kind !== "skill") return out;
    const rest = out.slice(first.lead.length);
    if (skillLead(rest, options.skills, options.commands ?? COMMANDS).chip) {
      out = rest;
    } else {
      return out;
    }
  }
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
    commands,
  }: {
    skills: ReadonlySet<string> | null;
    goals: boolean;
    /** The composer's command words (default: /model, and /goal where
     *  goals run). */
    commands?: ReadonlySet<string>;
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
  return skillLead(
    text,
    skills,
    commands ?? (goals ? COMMANDS : new Set(["model"]))
  );
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
  // Without markers nothing was pinned. With them the backend vouches for
  // the text, so its whitespace is read unbounded (the bound is live
  // input's, read every render).
  if (pinned.length === 0) return { skills, rest: text };
  const spaces = (from: number) => {
    let i = from;
    while (i < text.length && PY_SPACE.test(text[i])) i++;
    return i;
  };
  let at = spaces(0);
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
    at = spaces(end);
    restAt = at;
  }
  return { skills, rest: text.slice(restAt) };
}
