import { describe, expect, it } from "vitest";

import { readyProjects } from "@/test/mockProjects";
import type { ProjectsState } from "@/lib/projects";
import { workspaceAssistantId } from "@/lib/workspaceAssistant";
import {
  AGENT_GRAPHS,
  CHAT_GRAPHS,
  bindingAssistantId,
  threadBinding,
  threadFolders,
  type ThreadFolders,
  runFolderIn,
} from "./threadBinding";

const A = "/home/you/projA";
const B = "/srv/projB";
const ready: ProjectsState = readyProjects(A, B);

function folders(over: Partial<ThreadFolders> = {}): ThreadFolders {
  return {
    graphId: "EvoScientist",
    workspaceDir: A,
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

it("takes the graph from the thread's own metadata only", () => {
  // The run's assistant comes from the thread's metadata; the binding's graph
  // must be the same one.
  expect(threadFolders({}, { graph_id: "scheduler" }).graphId).toBeNull();
});

describe("threadBinding", () => {
  it("waits while the projects or the thread are loading", () => {
    expect(
      threadBinding({ status: "pending" }, null, CHAT_GRAPHS, A).kind
    ).toBe("pending");
    expect(threadBinding(ready, undefined, CHAT_GRAPHS, A).kind).toBe(
      "pending"
    );
  });

  it("runs a new chat in the current project", () => {
    expect(threadBinding(ready, null, CHAT_GRAPHS, B)).toEqual({
      kind: "open",
      key: B,
    });
  });

  it("runs a thread in its own project, whichever is current", () => {
    expect(
      threadBinding(ready, folders({ workspaceDir: B }), CHAT_GRAPHS, A)
    ).toEqual({ kind: "open", key: B });
  });

  it("makes a thread of a folder that isn't a project read-only, naming it", () => {
    const binding = threadBinding(
      ready,
      folders({ workspaceDir: "/home/you/projC" }),
      CHAT_GRAPHS,
      A
    );
    expect(binding).toMatchObject({
      kind: "readOnly",
      folder: "/home/you/projC",
    });
    expect(binding.kind === "readOnly" && binding.reason).toContain("projC");
  });

  it("makes a thread of a project whose folder is missing read-only", () => {
    const missing = readyProjects(A, { key: B, name: "projB", missing: true });
    const binding = threadBinding(
      missing,
      folders({ workspaceDir: B }),
      CHAT_GRAPHS,
      A
    );
    expect(binding.kind).toBe("readOnly");
    expect(binding.kind === "readOnly" && binding.folder).toBeFalsy();
  });

  it("makes a thread that works in a run folder read-only", () => {
    expect(
      threadBinding(
        ready,
        folders({ runDir: "/home/you/projA/runs/r1" }),
        CHAT_GRAPHS,
        A
      ).kind
    ).toBe("readOnly");
  });

  it("lets a thread with no folder join the current project", () => {
    expect(
      threadBinding(ready, folders({ workspaceDir: null }), CHAT_GRAPHS, B)
    ).toEqual({ kind: "unbound", key: B });
  });

  it("runs nothing without a current project", () => {
    expect(threadBinding(ready, null, CHAT_GRAPHS, null).kind).toBe("readOnly");
    expect(
      threadBinding(ready, folders({ workspaceDir: null }), CHAT_GRAPHS, null)
        .kind
    ).toBe("readOnly");
  });

  it("runs nothing on a core without the project list", () => {
    expect(
      threadBinding({ status: "unsupported" }, folders(), CHAT_GRAPHS, A).kind
    ).toBe("readOnly");
  });

  it("makes threads of graphs this surface doesn't run read-only", () => {
    expect(
      threadBinding(
        ready,
        folders({ graphId: "evomemory-turn-worker" }),
        CHAT_GRAPHS,
        A
      ).kind
    ).toBe("readOnly");
    expect(
      threadBinding(
        ready,
        folders({ graphId: "writing-agent" }),
        AGENT_GRAPHS,
        A
      ).kind
    ).toBe("open");
  });
});

describe("bindingAssistantId", () => {
  it("is the graph's assistant for the binding's project", () => {
    expect(
      bindingAssistantId(
        threadBinding(ready, folders({ workspaceDir: B }), CHAT_GRAPHS, A),
        "scheduler"
      )
    ).toBe(workspaceAssistantId("scheduler", B));
  });

  it("is null for a thread that can't run", () => {
    expect(
      bindingAssistantId(
        threadBinding(
          ready,
          folders({ runDir: "/home/you/projA/runs/r1" }),
          CHAT_GRAPHS,
          A
        ),
        "EvoScientist"
      )
    ).toBeNull();
  });
});

describe("runFolderIn", () => {
  it("names a run folder by its path inside the project", () => {
    expect(runFolderIn("/home/you/projA", "/home/you/projA/runs/exp-3")).toBe(
      "runs/exp-3"
    );
    expect(runFolderIn("C:\\work\\projA", "C:\\work\\projA\\runs\\exp-3")).toBe(
      "runs/exp-3"
    );
  });

  it("names nothing for a folder outside the project", () => {
    expect(
      runFolderIn("/home/you/projA", "/home/you/projAB/runs/x")
    ).toBeNull();
    expect(runFolderIn("/home/you/projA", "/home/you/projA")).toBeNull();
  });
});
