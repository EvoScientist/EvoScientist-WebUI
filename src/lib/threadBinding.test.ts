import { describe, expect, it } from "vitest";

import { readyWorkspace } from "@/test/mockWorkspace";
import type { WorkspaceState } from "@/lib/workspaceSession";
import {
  AGENT_GRAPHS,
  CHAT_GRAPHS,
  threadBinding,
  threadFolders,
  type ThreadFolders,
} from "./threadBinding";

const ready: WorkspaceState = readyWorkspace("/home/you/projA");

function folders(over: Partial<ThreadFolders> = {}): ThreadFolders {
  return {
    graphId: "EvoScientist",
    workspaceDir: "/home/you/projA",
    runDir: null,
    ...over,
  };
}

describe("threadFolders", () => {
  it("prefers the thread's own metadata over the latest checkpoint", () => {
    expect(
      threadFolders(
        { graph_id: "EvoScientist", workspace_dir: "/home/you/projA" },
        { workspace_dir: "/home/you/old-spelling", run_dir: "/x" }
      )
    ).toEqual(folders());
  });

  it("falls back to the latest checkpoint", () => {
    expect(
      threadFolders(
        { graph_id: "EvoScientist" },
        {
          workspace_dir: "/home/you/projA",
          run_dir: "/home/you/projA/runs/r1",
        }
      )
    ).toEqual(folders({ runDir: "/home/you/projA/runs/r1" }));
  });
});

describe("threadBinding", () => {
  it("waits while the workspace or the thread is loading", () => {
    expect(threadBinding({ status: "pending" }, null, CHAT_GRAPHS).kind).toBe(
      "pending"
    );
    expect(threadBinding(ready, undefined, CHAT_GRAPHS).kind).toBe("pending");
  });

  it("runs a new chat and a thread of the backend's folder", () => {
    expect(threadBinding(ready, null, CHAT_GRAPHS).kind).toBe("open");
    expect(threadBinding(ready, folders(), CHAT_GRAPHS).kind).toBe("open");
  });

  it("makes a thread of another folder read-only", () => {
    const binding = threadBinding(
      ready,
      folders({ workspaceDir: "/home/you/projB" }),
      CHAT_GRAPHS
    );
    expect(binding.kind).toBe("readOnly");
    expect(binding.kind === "readOnly" && binding.reason).toContain("projB");
  });

  it("makes a thread that works in a run folder read-only", () => {
    expect(
      threadBinding(
        ready,
        folders({ runDir: "/home/you/projA/runs/r1" }),
        CHAT_GRAPHS
      ).kind
    ).toBe("readOnly");
  });

  it("lets a thread with no folder join the backend's folder", () => {
    expect(
      threadBinding(ready, folders({ workspaceDir: null }), CHAT_GRAPHS).kind
    ).toBe("unbound");
  });

  it("makes threads of graphs this surface doesn't run read-only", () => {
    expect(
      threadBinding(
        ready,
        folders({ graphId: "evomemory-turn-worker" }),
        CHAT_GRAPHS
      ).kind
    ).toBe("readOnly");
    expect(
      threadBinding(ready, folders({ graphId: "writing-agent" }), AGENT_GRAPHS)
        .kind
    ).toBe("open");
  });

  it("locks folder graphs while a run-mode session holds the backend", () => {
    const held: WorkspaceState = {
      ...readyWorkspace("/home/you/projA"),
      runDir: "/home/you/projA/runs/r1",
    };
    expect(threadBinding(held, null, CHAT_GRAPHS).kind).toBe("readOnly");
    expect(
      threadBinding(held, folders({ graphId: "scheduler" }), CHAT_GRAPHS).kind
    ).toBe("open");
  });

  it("checks no folders on a backend without the workspace route", () => {
    expect(
      threadBinding(
        { status: "legacy" },
        folders({ workspaceDir: "/home/you/projB" }),
        CHAT_GRAPHS
      ).kind
    ).toBe("open");
  });
});
