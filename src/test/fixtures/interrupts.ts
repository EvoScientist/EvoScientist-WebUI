// Shape mirrors what LangChain's HumanInTheLoopMiddleware emits on the
// SDK stream — a top-level `{value}` wrapper with `action_requests` or a
// `type: "ask_user"` payload inside. Fresh object identity per call so
// tests can assert on identity-guard behavior.

import type { ActionRequest } from "@/app/types/types";
import {
  executeActionRequest,
  spawnAgentActionRequest,
} from "./actionRequests";

export const executeInterrupt = (command = "ls", id = "int-1") => ({
  id,
  value: {
    action_requests: [executeActionRequest(command)],
  },
});

export const spawnAgentInterrupt = (id = "int-1") => ({
  id,
  value: {
    action_requests: [spawnAgentActionRequest()],
  },
});

export const multiActionInterrupt = (
  requests: ActionRequest[] = [
    executeActionRequest("ls"),
    executeActionRequest("pwd"),
  ],
  id = "int-1"
) => ({
  id,
  value: {
    action_requests: requests,
  },
});

export const askUserInterrupt = (question = "what next?") => ({
  value: {
    type: "ask_user",
    questions: [{ question }],
  },
});

export const emptyActionsInterrupt = (id = "int-1") => ({
  id,
  value: {
    action_requests: [],
  },
});
