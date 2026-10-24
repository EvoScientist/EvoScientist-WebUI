// The composer's `/` menu: which skill name is being typed, which installed
// skills match it, and what picking one does to the message.
//
// EvoScientist pins the skills named by the leading `/name` words of a
// message (`message_meta.parse_skill_slashes`): each word must be a whole
// `/name` of lowercase letters, digits and single hyphens, and the first word
// that isn't ends the run. So the menu only helps there. Words split where
// Python's `str.split()` splits them.

import { PY_SPACE } from "./pythonWhitespace";

/** A whole `/name` the backend pins. */
export const PIN_WORD = /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
// What may already be typed of a name: the menu filters as it grows.
const PARTIAL = /^[a-z0-9-]*$/;
// The WebUI's own commands: a message that starts with one is the command's.
const COMMANDS = new Set(["model", "goal"]);

/** A WebUI command the `/` menu offers as a message's first word. */
export interface MenuCommand {
  /** The command's word after the slash: "goal". */
  word: string;
  /** The row after the slash: "goal amend <feedback>". */
  label: string;
  /** What choosing the row writes in place of the typed word. */
  insert: string;
  description: string;
  /** Needs nothing more: chosen with Enter or a click it runs at once, where
   *  the composer's `runnerFor` can run it (the typed word goes); Tab still
   *  writes it out. */
  run?: boolean;
}

export interface SlashToken {
  /** Where the `/` is. */
  start: number;
  /** The caret: the end of what was typed. */
  end: number;
  /** What follows the `/`. */
  query: string;
  /** The names already pinned by the words before it. */
  pinned: string[];
}

/** The `/name` being typed at `caret`, if the backend would pin it. This runs
 *  on every render of the composer, so it reads no more of a long paste than
 *  a pin can be: each word ends within `/` and 64 characters, and the words
 *  before the caret's stop at the first that isn't a pin. */
export function slashTokenAt(text: string, caret: number): SlashToken | null {
  if (caret <= 0 || caret > text.length) return null;
  // The caret has to end the word, not sit inside it.
  if (caret < text.length && !PY_SPACE.test(text[caret])) return null;
  let start = caret;
  while (start > 0 && !PY_SPACE.test(text[start - 1])) {
    if (caret - start > MAX_NAME) return null;
    start--;
  }
  if (text[start] !== "/") return null;
  const query = text.slice(start + 1, caret);
  if (!PARTIAL.test(query)) return null;
  // Every word before it must be a pin, as the backend reads them.
  const pinned: string[] = [];
  for (let i = 0; ; ) {
    while (i < start && PY_SPACE.test(text[i])) i++;
    if (i === start) break;
    let j = i;
    while (!PY_SPACE.test(text[j])) {
      if (j - i > MAX_NAME) return null;
      j++;
    }
    const word = text.slice(i, j);
    if (!PIN_WORD.test(word)) return null;
    pinned.push(word.slice(1));
    i = j;
  }
  // `/model …` is the WebUI's model command, not a pin.
  if (COMMANDS.has(pinned[0] ?? query)) return null;
  return { start, end: caret, query, pinned };
}

/** The skills matching `query`: names starting with it, then names containing
 *  it, then descriptions containing it; skills already pinned are left out. */
export function rankSkills<T extends { name: string; description: string }>(
  skills: readonly T[],
  query: string,
  pinned: readonly string[]
): T[] {
  const q = query.toLowerCase();
  const rank = (s: T) =>
    s.name.startsWith(q)
      ? 0
      : s.name.includes(q)
      ? 1
      : s.description.toLowerCase().includes(q)
      ? 2
      : 3;
  return skills
    .filter((s) => !pinned.includes(s.name))
    .map((s) => ({ s, r: rank(s) }))
    .filter(({ r }) => r < 3)
    .sort((a, b) => a.r - b.r || a.s.name.localeCompare(b.s.name))
    .map(({ s }) => s);
}

/** The message with `name` in place of the typed word, and the caret past
 *  the whitespace after it: what followed is kept (a newline stays one), and
 *  a space is added at the end of the message. */
export function applySkill(
  text: string,
  token: SlashToken,
  name: string
): { text: string; caret: number } {
  const head = `${text.slice(0, token.start)}/${name}`;
  const rest = text.slice(token.end) || " ";
  return { text: head + rest, caret: head.length + 1 };
}
