// @vitest-environment jsdom
//
// The left rail's Experts entry. It is the only way into the view, and it
// carries the same toggle semantics as the entries beside it: clicking the
// active one goes back to the conversation.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({
  view: null as string | null,
  setView: vi.fn(),
  // What useSettings() reports: undefined before an answer and against an
  // EvoScientist without /api/settings.
  settings: undefined as object | undefined,
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
  useMemoryActivity: () => ({ unseenCount: 0, markSeen: vi.fn() }),
}));

vi.mock("@/app/hooks/useThreads", () => ({
  useThreads: () => ({
    data: [[]],
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

beforeEach(() => {
  nav.view = null;
  nav.settings = undefined;
  nav.setView.mockClear();
});

describe("left rail Experts entry", () => {
  const renderRail = () =>
    render(
      <ThreadList
        onThreadSelect={vi.fn()}
        onMutateReady={vi.fn()}
        onInterruptCountChange={vi.fn()}
      />
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
      <ThreadList
        onThreadSelect={vi.fn()}
        onMutateReady={vi.fn()}
        onInterruptCountChange={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /^experts$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^setup$/i })).toBeNull();
  });
});
