// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTOSKILLS_REFRESH_MS,
  useAutoSkills,
} from "@/app/hooks/useAutoSkills";
import {
  mockProjects,
  readyProjects,
  TestProjectsProvider,
} from "@/test/mockProjects";

// The Run-now provider reads the drafts for the whole page; the readers that
// show them (the rail, the Skills page) keep them fresh, on one timer for
// the list between them. Its own reader doesn't count for that timer: alone,
// it reads nothing on the interval.

const client = vi.hoisted(() => ({ runs: { get: vi.fn() } }));
vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => client,
  useDeployment: () => ({ deploymentUrl: "http://127.0.0.1:6174", apiKey: "" }),
}));

import { RunNowProvider } from "./RunNowProvider";

function Rail() {
  useAutoSkills();
  return null;
}

function SkillsPage() {
  useAutoSkills();
  return null;
}

function tree(rail: boolean, skillsPage = false) {
  return (
    <SWRConfig value={{ provider: () => new Map() }}>
      <TestProjectsProvider value={mockProjects(readyProjects("/work/A"))}>
        <RunNowProvider>
          {rail && <Rail />}
          {skillsPage && <SkillsPage />}
        </RunNowProvider>
      </TestProjectsProvider>
    </SWRConfig>
  );
}

const drafts = () =>
  new Response(
    JSON.stringify({
      proposals: [],
      counts: { pending: 0, approved: 0, rejected: 0 },
      by_project: {},
    }),
    { status: 200 }
  );

const reads = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith("/api/autoskills/proposals")
  ).length;

async function settle(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RunNowProvider reads", () => {
  it("with the rail mounted, the drafts are read once a minute", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => drafts());
    vi.stubGlobal("fetch", fetchMock);
    // The page opens with the sidebar closed; the rail mounts 20 s later.
    const view = render(tree(false));
    await settle(20_000);
    view.rerender(tree(true));
    // The rail's own first read (on its mount) lands first.
    await settle(1_000);
    const asked = reads(fetchMock);
    await settle(AUTOSKILLS_REFRESH_MS * 5);
    expect(reads(fetchMock)).toBe(asked + 5);
    view.unmount();
  });

  it("with the rail and the Skills page mounted at different times, still once a minute", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => drafts());
    vi.stubGlobal("fetch", fetchMock);
    const view = render(tree(false));
    await settle(20_000);
    view.rerender(tree(true));
    // The Skills page is opened 25 s after the sidebar.
    await settle(25_000);
    view.rerender(tree(true, true));
    await settle(1_000);
    const asked = reads(fetchMock);
    await settle(AUTOSKILLS_REFRESH_MS * 5);
    expect(reads(fetchMock)).toBe(asked + 5);
    view.unmount();
  });

  it("alone, the provider's reader reads nothing on the interval", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => drafts());
    vi.stubGlobal("fetch", fetchMock);
    const view = render(tree(false));
    await settle(1_000);
    const asked = reads(fetchMock);
    expect(asked).toBe(1);
    await settle(AUTOSKILLS_REFRESH_MS * 5);
    expect(reads(fetchMock)).toBe(asked);
    view.unmount();
  });
});
