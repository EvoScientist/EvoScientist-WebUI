import type { ActionRequest, Decision } from "@/lib/hitl";

export const HITL_SHELL_TOOLS = ["execute", "run_in_background"] as const;
export const HITL_ALWAYS_PROMPT_TOOLS = ["schedule_task"] as const;

const PIPE_NETWORKING_RHS = new Set([
  "nc",
  "ncat",
  "netcat",
  "ssh",
  "curl",
  "wget",
  "telnet",
  "socat",
  "scp",
  "sftp",
  "rsync",
  "ftp",
]);

const PIPE_INTERPRETER_RHS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "ksh",
  "fish",
  "python",
  "python2",
  "python3",
  "node",
  "bun",
  "deno",
  "ruby",
  "perl",
  "php",
  "lua",
  "iex",
  "elixir",
]);

function matchDangerous(word: string): string | null {
  const base = word.split("/").pop() ?? word;
  const normalized = base.replace(/[0-9.]+$/, "") || base;
  const isNetworking =
    PIPE_NETWORKING_RHS.has(base) || PIPE_NETWORKING_RHS.has(normalized);
  const isInterpreter =
    PIPE_INTERPRETER_RHS.has(base) || PIPE_INTERPRETER_RHS.has(normalized);
  if (!isNetworking && !isInterpreter) return null;
  const kind = isNetworking ? "networking tool" : "interpreter";
  return `pipes output into ${kind} '${base}'`;
}

export function checkDangerousCommand(command: string): string | null {
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "|") {
      if (command[i + 1] === "|") {
        i += 2;
        continue;
      }
      i += 1;
      if (command[i] === "&") i += 1;
      while (i < command.length && /\s/.test(command[i])) i += 1;
      let j = i;
      let word = "";
      let done = false;
      while (j < command.length && !done) {
        const c = command[j];
        if (c === "'") {
          j += 1;
          while (j < command.length && command[j] !== "'") {
            word += command[j];
            j += 1;
          }
          j += 1;
        } else if (c === '"') {
          j += 1;
          while (j < command.length && command[j] !== '"') {
            if (command[j] === "\\" && j + 1 < command.length) {
              word += command[j + 1];
              j += 2;
            } else {
              word += command[j];
              j += 1;
            }
          }
          j += 1;
        } else if (c === "\\") {
          if (j + 1 < command.length) {
            word += command[j + 1];
          }
          j += 2;
        } else if (/[\s|;&<>]/.test(c)) {
          done = true;
        } else {
          word += c;
          j += 1;
        }
      }
      if (word) {
        const reason = matchDangerous(word);
        if (reason) return reason;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return null;
}

export function autoApproveDecisions(
  actionRequests: ActionRequest[]
): Decision[] | null {
  if (actionRequests.length === 0) return null;
  const decisions: Decision[] = [];
  for (const request of actionRequests) {
    if (
      (HITL_ALWAYS_PROMPT_TOOLS as readonly string[]).includes(request.name)
    ) {
      return null;
    }
    if (!(HITL_SHELL_TOOLS as readonly string[]).includes(request.name)) {
      decisions.push({ type: "approve" });
      continue;
    }
    const command =
      request.args && typeof request.args["command"] === "string"
        ? (request.args["command"] as string)
        : "";
    const reason = checkDangerousCommand(command);
    if (reason) decisions.push({ type: "reject", message: reason });
    else decisions.push({ type: "approve" });
  }
  return decisions;
}
