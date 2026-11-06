// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft, DraftList } from "@/lib/autoskills";
import {
  mockProjects,
  readyProjects,
  TestProjectsProvider,
} from "@/test/mockProjects";

// Run now's state lives above the views: the drafts page can be left (any
// view switch, the breadcrumb, a "Where it came from" link) while a run
// goes on, and coming back shows it still running.

const q = vi.hoisted(() => {
  const values = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  return { values, listeners };
});
vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    useQueryState: (key: string) => {
      const value = react.useSyncExternalStore(
        (l: () => void) => {
          q.listeners.add(l);
          return () => q.listeners.delete(l);
        },
        () => q.values.get(key) ?? null
      );
      const set = (next: string | null) => {
        q.values.set(key, next);
        for (const l of q.listeners) l();
        return Promise.resolve(new URLSearchParams());
      };
      return [value, set];
    },
  };
});

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

const state = vi.hoisted(() => ({
  list: null as unknown,
  refresh: vi.fn(),
  readNow: vi.fn(),
}));
vi.mock("@/app/hooks/useAutoSkills", () => ({
  useAutoSkills: () => ({
    status: "ready",
    list: state.list,
    refresh: state.refresh,
    readNow: state.readNow,
  }),
  markAutoSeen: vi.fn(),
  // The check before an approval: nothing it can't show, at once.
  useDraftFilesCheck: () => () => new Map(),
}));
vi.mock("@/app/hooks/useDraftActions", () => ({
  useDraftActions: () => ({
    approve: vi.fn(async () => ({ done: [], failed: [] })),
    reject: vi.fn(async () => ({ done: [], failed: [] })),
    busy: false,
  }),
}));
vi.mock("@/app/hooks/useSettings", () => ({
  useSettings: () => ({
    payload: { settings: { memory_skill_synthesis_enabled: true } },
  }),
  useSettingsAccess: () => ({ access: { writable: true }, refresh: vi.fn() }),
}));
const runsGet = vi.hoisted(() => vi.fn());
// One client for the deployment: a new one is a deployment switch, which
// drops the runs in flight.
const client = vi.hoisted(() => ({ runs: { get: runsGet } }));
vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => client,
  useDeployment: () => ({
    deploymentUrl: "http://127.0.0.1:6174",
    apiKey: "",
  }),
}));

import { DraftsPage } from "@/app/components/autoskills/DraftsPage";
import { RUN_POLL_MS } from "@/app/hooks/useRunNow";
import { RunNowProvider } from "./RunNowProvider";
import { useRunNowState, type RunNowValue } from "./runNowContext";

const A = "/work/EvoSci_test";
const B = "/work/project_B";

function draft(id: string, dir: string): Draft {
  return {
    proposal_id: id,
    skill_name: id,
    description: "",
    operation: "create",
    target_skill_name: null,
    scope: "workspace",
    submitted_scope: null,
    status: "pending",
    workspace_dir: dir,
    created_at: "2026-11-01T09:00:00Z",
    updated_at: "2026-11-01T09:00:00Z",
    approved_at: null,
    approved_by: null,
    rejected_at: null,
    approved_skill_path: null,
    approved_skill_present: null,
    source_observation_ids: [],
    skill_md: "",
    skill_md_truncated: false,
    rationale_md: "",
    rationale_md_truncated: false,
    files: [],
    install_target: null,
    install_base: null,
    install_error: null,
  };
}
function listOf(drafts: Draft[]): DraftList {
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const d of drafts) counts[d.status] += 1;
  return { drafts, counts, byProject: {} };
}

let bodies: Array<Record<string, unknown>>;
function stubRelay(status: number, body: Record<string, unknown>) {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      );
    })
  );
}

/** What the provider hands its views, read by a probe beside the page. */
const seen: { value: RunNowValue | null } = { value: null };
function Probe() {
  seen.value = useRunNowState();
  return null;
}

function Shell({ show }: { show: boolean }) {
  return (
    <TestProjectsProvider value={mockProjects(readyProjects(A, B))}>
      <RunNowProvider>
        <Probe />
        {show ? <DraftsPage /> : <p>Another view</p>}
      </RunNowProvider>
    </TestProjectsProvider>
  );
}

const runButton = () =>
  within(screen.getByRole("group", { name: "project_B" })).getByRole("button", {
    name: /^(Run now|Running…)$/,
  }) as HTMLButtonElement;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  q.values.clear();
  toast.success.mockClear();
  toast.error.mockClear();
  toast.info.mockClear();
  runsGet.mockReset();
  state.list = listOf([]);
  state.refresh.mockReset();
  state.readNow.mockReset();
  seen.value = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RunNowProvider", () => {
  it("a run goes on while the drafts page is away and ends with its toast", async () => {
    stubRelay(200, { thread_id: "t1", run_id: "r1" });
    runsGet
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValue({ status: "success" });
    state.readNow.mockResolvedValue(listOf([draft("n1", B)]));
    const view = render(<Shell show />);

    fireEvent.click(runButton());
    await advance(0);
    expect(bodies).toEqual([{ action: "run", workspace_dir: B }]);
    expect(runButton().textContent).toBe("Running…");

    // Another view: the page goes, the run doesn't.
    view.rerender(<Shell show={false} />);
    expect(screen.queryByRole("group", { name: "project_B" })).toBeNull();
    await advance(RUN_POLL_MS);
    expect(runsGet).toHaveBeenCalledTimes(1);
    expect(seen.value?.running.has(B)).toBe(true);

    // Back: still running, and Run now can't start it twice.
    view.rerender(<Shell show />);
    expect(runButton().textContent).toBe("Running…");
    expect(runButton().disabled).toBe(true);
    await act(async () => {
      await seen.value?.run(B);
    });
    expect(bodies).toHaveLength(1);

    await advance(RUN_POLL_MS);
    expect(toast.success).not.toHaveBeenCalled();
    await advance(RUN_POLL_MS);
    expect(runsGet).toHaveBeenCalledTimes(3);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: 1 new draft."
    );
    expect(runButton().textContent).toBe("Run now");
    expect(runButton().disabled).toBe(false);
  });

  it("the end of a run left on another view is still said", async () => {
    stubRelay(200, { thread_id: "t1", run_id: "r1" });
    runsGet.mockResolvedValue({ status: "running" });
    state.readNow.mockResolvedValue(listOf([]));
    const view = render(<Shell show />);
    fireEvent.click(runButton());
    await advance(0);
    view.rerender(<Shell show={false} />);
    await advance(RUN_POLL_MS * 3);
    runsGet.mockResolvedValue({ status: "success" });
    await advance(RUN_POLL_MS);
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: no new patterns this time."
    );
    expect(seen.value?.running.size).toBe(0);
  });
});
