// The status page: shows the screen the main process sends (progress, the
// install script's last lines, setup's stages, the mirror question, or an
// error with its actions). It never calls the backend: the core's browser
// boundary refuses requests from a file:// page (Origin: null).
"use strict";

const LABELS = {
  retry: "Retry",
  restart_ui: "Retry",
  set_port: "Use this port",
  choose_folder: "Choose folder...",
  copy_command: "Copy command",
  open_logs: "Open log folder",
  open_config: "Open config folder",
  open_crash: "Open folder",
  quit: "Quit",
  mirror_default: "No, use the default sources",
  mirror_cn: "Yes, use mainland China mirrors",
  retry_cn: "Retry with mainland China mirrors",
  continue: "Continue without them",
};

/** A stage's state as a short word next to its title. */
const STATE_LABELS = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  skipped: "Skipped",
  error: "Failed",
};

const $ = (id) => document.getElementById(id);
let shownPortKey = null;

/** One line of screen text as a paragraph. */
function paragraph(text, cls) {
  const p = document.createElement("p");
  p.textContent = text;
  if (cls) p.className = cls;
  return p;
}

/** The stage list: title, state and, while running, a progress bar and the
 *  stage's message; a failed stage shows its code and message. */
function stageList(stages) {
  return stages.map((st) => {
    const li = document.createElement("li");
    li.className = `stage ${st.state}`;
    const head = document.createElement("div");
    head.className = "stage-head";
    const name = document.createElement("span");
    name.textContent = st.title;
    const state = document.createElement("span");
    state.className = "stage-state";
    state.textContent = STATE_LABELS[st.state] ?? st.state;
    head.append(name, state);
    li.append(head);
    if (st.state === "running") {
      const bar = document.createElement("progress");
      if (typeof st.progress === "number") bar.value = st.progress;
      li.append(bar);
    }
    const note =
      st.state === "error"
        ? [st.code, st.message].filter(Boolean).join(": ")
        : st.message;
    if (note) li.append(paragraph(note, "muted"));
    return li;
  });
}

/** Draws a screen: title, lines, the install output or the stage list,
 *  command, port field and buttons. */
function render(s) {
  if (!s) return;
  const error = s.kind === "error";
  const title = $("title");
  title.textContent = s.title;
  title.className = error ? "error" : "";
  if (error) {
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = s.code;
    title.appendChild(code);
  }
  const busy = s.kind === "progress" || s.kind === "install";
  $("spinner").hidden = !busy;
  const lines =
    s.kind === "error" || s.kind === "question" ? s.lines : [s.message];
  $("lines").replaceChildren(...lines.filter(Boolean).map((l) => paragraph(l)));
  const output = s.output ?? [];
  $("output").hidden = output.length === 0;
  $("output").textContent = output.join("\n");
  // The newest line stays in view while the install runs.
  $("output").scrollTop = $("output").scrollHeight;
  const stages = s.stages ?? [];
  $("stages").hidden = stages.length === 0;
  $("stages").replaceChildren(...stageList(stages));
  $("command").hidden = !(error && s.command);
  $("command-text").textContent = (error && s.command) || "";
  const wantsPort = error && s.actions.includes("set_port");
  $("port").hidden = !wantsPort;
  // Each new error screen suggests its own port; typing is kept until then.
  const portKey = wantsPort ? `${s.code}:${s.port}` : null;
  if (portKey && portKey !== shownPortKey)
    $("port-input").value = String(s.port ?? "");
  shownPortKey = portKey;
  const buttons = s.actions
    ? s.actions.map((id, i) => {
        const b = document.createElement("button");
        b.textContent = LABELS[id] ?? id;
        if (i === 0) b.className = "primary";
        b.addEventListener("click", () => run(id));
        return b;
      })
    : [];
  $("actions").replaceChildren(...buttons);
  const paths = [];
  if (error) {
    paths.push(`Logs: ${s.logFolder}`);
    if (s.crashReport) paths.push(`Crash report: ${s.crashReport}`);
  }
  $("paths").textContent = paths.join("  ·  ");
}

/** Sends an action to the main process; the port field's value goes with `set_port`. */
async function run(id) {
  const arg = id === "set_port" ? Number($("port-input").value) : undefined;
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  try {
    await window.evoStatus.act(id, arg);
  } finally {
    for (const b of document.querySelectorAll("button")) b.disabled = false;
  }
}

window.evoStatus.onScreen(render);
window.evoStatus.get().then(render);
