/**
 * How the file preview shows a file, decided by extension, plus the workspace
 * file API URL. Shared by the workspace, memory and agent-state views.
 */

/** Syntax-highlighting language per extension. */
export const LANGUAGE_MAP: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  cpp: "cpp",
  c: "c",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  jsonl: "json",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  tex: "latex",
  bib: "latex",
  r: "r",
  dockerfile: "dockerfile",
  makefile: "makefile",
};

// Workspace files shown as text — the list the workspace dialog used, so what
// can be previewed and edited doesn't change. Anything else that isn't an
// image or a PDF is offered as a download.
const TEXT_EXTS = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "cpp",
  "c",
  "cs",
  "php",
  "swift",
  "kt",
  "sh",
  "bash",
  "zsh",
  "json",
  "jsonl",
  "xml",
  "html",
  "css",
  "scss",
  "sql",
  "yaml",
  "yml",
  "toml",
  "ini",
  "tex",
  "bib",
  "r",
  "txt",
  "md",
  "markdown",
  "log",
  "csv",
  "tsv",
  "cfg",
  "conf",
  "env",
  "gitignore",
]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);

/** Inline text preview cap; bigger files are offered as a download. */
export const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024;

export type FileKind = "text" | "image" | "pdf" | "binary";

export function fileNameOf(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

export function extOf(name: string): string {
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

export function fileKindOf(ext: string): FileKind {
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTS.has(ext)) return "text";
  return "binary";
}

export function isMarkdownExt(ext: string): boolean {
  return ext === "md" || ext === "markdown";
}

export function workspaceFileUrl(
  path: string,
  opts: { download?: boolean; version?: number } = {}
): string {
  const qs = new URLSearchParams({ path });
  if (opts.download) qs.set("download", "1");
  // Only defeats the browser cache when an image or PDF is shown again.
  if (opts.version) qs.set("v", String(opts.version));
  return `/api/workspace/file?${qs.toString()}`;
}
