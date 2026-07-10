import type { ActionRequest } from "@/app/types/types";

export const executeActionRequest = (
  command = "ls -la /workspace"
): ActionRequest => ({
  name: "execute",
  args: { command },
});

export const spawnAgentActionRequest = (
  agent = "writing-agent",
  input = "draft the introduction"
): ActionRequest => ({
  name: "spawn_agent",
  args: { agent, input },
});

export const readFileActionRequest = (
  path = "/memories/notes.md"
): ActionRequest => ({
  name: "read_file",
  args: { path },
});

export const actionRequestWithDescription = (): ActionRequest => ({
  name: "write_file",
  args: { path: "/workspace/out.md", content: "hello" },
  description: "Save the draft to the workspace.",
});
