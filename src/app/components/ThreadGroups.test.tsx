// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ThreadItem, ThreadPage } from "@/app/hooks/useThreads";

const list = vi.hoisted(() => ({
  pages: [] as ThreadPage[],
  setSize: vi.fn(),
}));

vi.mock("@/app/hooks/useThreads", () => ({
  useThreads: () => ({
    data: list.pages,
    size: list.pages.length,
    setSize: list.setSize,
    mutate: vi.fn(),
    error: undefined,
  }),
}));

import { ThreadGroups } from "./ThreadGroups";

const thread = (id: string): ThreadItem => ({
  id,
  updatedAt: new Date(),
  status: "idle",
  title: `Thread ${id}`,
  description: "",
  pinned: false,
  needsUserInput: false,
  workspaceDir: null,
  runDir: null,
});

function renderGroups(exclude: ReadonlySet<string> = new Set()) {
  return render(
    <ThreadGroups
      scope="noProject"
      search=""
      exclude={exclude}
      now={new Date()}
      revision={0}
      renderThread={(t) => <p key={t.id}>{t.title}</p>}
      emptyText="None."
    />
  );
}

describe("ThreadGroups", () => {
  it("reads more by itself while the loaded pages show nothing", () => {
    list.setSize.mockClear();
    list.pages = [{ items: [], full: true }];

    renderGroups();

    expect(list.setSize).toHaveBeenCalledWith(2);
  });

  it("stops reading by itself after a few pages and says why it's empty", () => {
    list.setSize.mockClear();
    list.pages = Array.from({ length: 5 }, () => ({ items: [], full: true }));

    renderGroups();

    expect(list.setSize).not.toHaveBeenCalled();
    expect(
      screen.getByText("None in the conversations read so far.")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load More" })).toBeTruthy();
  });

  it("leaves out threads shown elsewhere", () => {
    list.pages = [{ items: [thread("a"), thread("b")], full: false }];

    renderGroups(new Set(["a"]));

    expect(screen.queryByText("Thread a")).toBeNull();
    expect(screen.getByText("Thread b")).toBeTruthy();
  });

  // ThreadList passes a new inline callback on every render; reporting again
  // on each one fed a first-load render loop (React #185).
  it("reports emptiness once per change, to the parent's latest callback", () => {
    list.pages = [{ items: [], full: false }];
    const reports: Array<[string, boolean]> = [];
    const exclude = new Set<string>();
    const now = new Date();
    const groups = (from: string) => (
      <ThreadGroups
        scope="noProject"
        search=""
        exclude={exclude}
        now={now}
        revision={0}
        renderThread={(t) => <p key={t.id}>{t.title}</p>}
        emptyText="None."
        onEmptyChange={(empty) => reports.push([from, empty])}
      />
    );

    const view = render(groups("first"));
    view.rerender(groups("second"));
    view.rerender(groups("third"));
    expect(reports).toEqual([["first", true]]);

    // A thread arrives: told once, through the newest callback.
    list.pages = [{ items: [thread("a")], full: false }];
    view.rerender(groups("fourth"));
    view.rerender(groups("fifth"));
    expect(reports).toEqual([
      ["first", true],
      ["fourth", false],
    ]);
  });
});
