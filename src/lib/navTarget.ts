/** A Memory view tab. */
export type MemoryTab = "identity" | "knowledge" | "history";

/** Where the dashboard, the chat and the page can send the user. */
export type NavTarget =
  | { view: "memory"; tab: MemoryTab; obsId?: string; execId?: string }
  | { view: "schedule" }
  | { view: "workspace" }
  | { view: "experts" }
  | { view: "skills" }
  | { view: "setup" };
