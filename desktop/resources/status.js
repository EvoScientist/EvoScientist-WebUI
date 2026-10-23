// The status page: shows the screen the main process sends (progress, or an
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
};

const $ = (id) => document.getElementById(id);

function paragraph(text, cls) {
  const p = document.createElement("p");
  p.textContent = text;
  if (cls) p.className = cls;
  return p;
}

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
  $("spinner").hidden = error;
  $("lines").replaceChildren(
    ...(error ? s.lines : [s.message]).filter(Boolean).map((l) => paragraph(l))
  );
  $("command").hidden = !(error && s.command);
  $("command-text").textContent = (error && s.command) || "";
  const wantsPort = error && s.actions.includes("set_port");
  $("port").hidden = !wantsPort;
  if (wantsPort && !$("port-input").value)
    $("port-input").value = String(s.port ?? "");
  const buttons = error
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
