// @vitest-environment jsdom
//
// The left rail's Experts entry. It is the only way into the view, and it
// carries the same toggle semantics as the entries beside it: clicking the
// active one goes back to the conversation.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const nav = vi.hoisted(() => ({
  view: null as string | null,
  setView: vi.fn(),
  // What useSettings() reports: undefined before an answer and against an
  // EvoScientist without /api/settings.
  settings: undefined as object | undefined,
  // The drafts the deployment answered (useAutoSkills).
  auto: { status: "loading" } as Record<string, unknown>,
  memoryUnseen: 0,
}));

vi.mock("@/app/hooks/useAutoSkills", () => ({
  useAutoSkills: () => ({ ...nav.auto, refresh: vi.fn() }),
}));

vi.mock("@/app/hooks/useSettings", () => ({
  useSettings: () => ({ payload: nav.settings }),
}));

vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    useQueryState: (key: string) =>
      key === "view"
        ? [nav.view, nav.setView]
        : react.useState<string | null>(null),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("@/app/hooks/useMemoryActivity", () => ({
  useMemoryActivity: () => ({
    unseenCount: nav.memoryUnseen,
    markSeen: vi.fn(),
  }),
}));

vi.mock("@/app/hooks/useThreads", () => ({
  useThreads: () => ({
    data: [{ items: [], full: false }],
    size: 1,
    setSize: vi.fn(),
    mutate: vi.fn(),
    isLoading: false,
    error: undefined,
  }),
  deleteThread: vi.fn(async () => {}),
  renameThread: vi.fn(async () => {}),
  pinThread: vi.fn(async () => {}),
  exportThread: vi.fn(async () => {}),
}));

import { ThreadList } from "./ThreadList";
import {
  TEST_PROJECT,
  TestProjectsProvider,
  mockProjects,
  readyProjects,
} from "@/test/mockProjects";

beforeEach(() => {
  nav.view = null;
  nav.settings = undefined;
  nav.auto = { status: "loading" };
  nav.memoryUnseen = 0;
  nav.setView.mockClear();
});

describe("left rail Experts entry", () => {
  const renderRail = () =>
    render(
      <TestProjectsProvider>
        <ThreadList
          onThreadSelect={vi.fn()}
          onMutateReady={vi.fn()}
          onInterruptCountChange={vi.fn()}
        />
      </TestProjectsProvider>
    );

  it("opens the Experts view", () => {
    renderRail();
    fireEvent.click(screen.getByRole("button", { name: /^experts$/i }));
    expect(nav.setView).toHaveBeenCalledWith("experts");
  });

  it("returns to the conversation when the active entry is clicked again", () => {
    nav.view = "experts";
    renderRail();
    fireEvent.click(screen.getByRole("button", { name: /^experts$/i }));
    expect(nav.setView).toHaveBeenCalledWith(null);
  });
});

// EvoScientist's settings live behind the header gear (the Settings page).
describe("left rail without Setup", () => {
  it("has no Setup entry, also once the deployment answered", () => {
    nav.settings = { setup_needed: false };
    render(
      <TestProjectsProvider>
        <ThreadList
          onThreadSelect={vi.fn()}
          onMutateReady={vi.fn()}
          onInterruptCountChange={vi.fn()}
        />
      </TestProjectsProvider>
    );
    expect(screen.getByRole("button", { name: /^experts$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^setup$/i })).toBeNull();
  });
});

// Drafts wait in every registered project; the rail counts all of them.
describe("left rail Research Skills count", () => {
  const B = "/work/EvoSci_test";
  const C = "/work/project_B";
  // The current project is TEST_PROJECT, which has no drafts waiting.
  const rail = () => (
    <TestProjectsProvider
      value={mockProjects(readyProjects(TEST_PROJECT, B, C), {
        current: TEST_PROJECT,
      })}
    >
      <ThreadList
        onThreadSelect={vi.fn()}
        onMutateReady={vi.fn()}
        onInterruptCountChange={vi.fn()}
      />
    </TestProjectsProvider>
  );
  const renderRail = () => render(rail());
  const skillsEntry = () =>
    screen.getByRole("button", { name: /^research skills/i });
  const counts = (pending: number) => ({ pending, approved: 0, rejected: 0 });
  const ready = (pending: number, byProject: Record<string, number> = {}) => {
    nav.auto = {
      status: "ready",
      list: {
        drafts: [],
        counts: { pending, approved: 4, rejected: 1 },
        byProject: Object.fromEntries(
          Object.entries(byProject).map(([key, n]) => [key, counts(n)])
        ),
      },
    };
  };

  it("the Research Skills entry counts pending drafts across projects", () => {
    ready(9, { [TEST_PROJECT]: 0, [B]: 7, [C]: 2 });
    nav.memoryUnseen = 3;
    renderRail();

    const badge = within(skillsEntry()).getByText("9");
    expect(badge.getAttribute("title")).toBe(
      "9 drafted skills wait for review"
    );
    expect(badge.getAttribute("aria-label")).toBe("9 drafted skills to review");
    // The EvoMemory entry's badge, drawn the same way.
    const memoryBadge = screen.getByLabelText("3 memory updates");
    expect(badge.className).toBe(memoryBadge.className);
  });

  it("keeps the count on every view, the skills view too", () => {
    ready(1);
    nav.view = "skills";
    renderRail();

    const badge = within(skillsEntry()).getByText("1");
    expect(badge.getAttribute("title")).toBe(
      "1 drafted skill waits for review"
    );
    expect(badge.getAttribute("aria-label")).toBe("1 drafted skill to review");
    // The entry still goes back to the conversation from its own view.
    fireEvent.click(skillsEntry());
    expect(nav.setView).toHaveBeenCalledWith(null);
  });

  it("no count on an old core", () => {
    nav.auto = { status: "unsupported" };
    const view = renderRail();
    expect(skillsEntry().textContent).toBe("Research Skills");

    // Nor while the drafts load, after a failed read, or with none waiting.
    for (const auto of [
      { status: "loading" },
      { status: "error", error: new Error("HTTP 500") },
    ]) {
      nav.auto = auto;
      view.rerender(rail());
      expect(skillsEntry().textContent).toBe("Research Skills");
    }
    ready(0);
    view.rerender(rail());
    expect(skillsEntry().textContent).toBe("Research Skills");
    expect(screen.queryByLabelText(/drafted skills? to review/)).toBeNull();
  });
});
