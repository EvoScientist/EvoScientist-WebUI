// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft, DraftList } from "@/lib/autoskills";
import { formatFullTime } from "@/lib/time";
import {
  mockProjects,
  readyProjects,
  TestProjectsProvider,
} from "@/test/mockProjects";

// The URL's query state: what each link writes.
const q = vi.hoisted(() => ({
  writes: [] as Array<[string, string | null]>,
}));
vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    useQueryState: (key: string) => {
      const [value, setValue] = react.useState<string | null>(null);
      const set = (next: string | null) => {
        q.writes.push([key, next]);
        setValue(next);
        return Promise.resolve(new URLSearchParams());
      };
      return [value, set];
    },
  };
});

const URL_ = "http://127.0.0.1:6174";

const hooks = vi.hoisted(() => ({
  auto: { status: "loading" } as Record<string, unknown>,
  seenAt: null as string | null,
  seenFor: [] as string[],
}));
vi.mock("@/app/hooks/useAutoSkills", () => ({
  useAutoSkills: () => ({ ...hooks.auto, refresh: vi.fn() }),
  readAutoSeenAt: (url: string) => {
    hooks.seenFor.push(url);
    return hooks.seenAt;
  },
}));
vi.mock("@/providers/ClientProvider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDeployment: () => ({ deploymentUrl: URL_, apiKey: "" }),
}));

import { DraftsBanner } from "./DraftsBanner";

const A = "/work/EvoSci_test";
const B = "/work/project_B";

function draft(over: Partial<Draft> & { proposal_id: string }): Draft {
  return {
    skill_name: over.proposal_id,
    description: "",
    operation: "create",
    target_skill_name: null,
    scope: "workspace",
    submitted_scope: null,
    status: "pending",
    workspace_dir: A,
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
    ...over,
  };
}

/** The list the core would answer for `drafts`: counts and the split by
 *  project from the drafts themselves. */
function ready(drafts: Draft[]) {
  const counts = { pending: 0, approved: 0, rejected: 0 };
  const byProject: DraftList["byProject"] = {};
  for (const d of drafts) {
    counts[d.status] += 1;
    byProject[d.workspace_dir] ??= { pending: 0, approved: 0, rejected: 0 };
    byProject[d.workspace_dir][d.status] += 1;
  }
  hooks.auto = { status: "ready", list: { drafts, counts, byProject } };
}

/** globals.css gives every <p> but a last child a 1rem bottom margin: in
 *  the banner each such one takes mb-0. */
function expectNoParagraphGaps(container: HTMLElement) {
  for (const p of container.querySelectorAll("p")) {
    if (p.nextElementSibling) expect(p.className).toContain("mb-0");
  }
}

const banner = () =>
  render(
    <TestProjectsProvider value={mockProjects(readyProjects(A, B))}>
      <DraftsBanner />
    </TestProjectsProvider>
  );

beforeEach(() => {
  q.writes = [];
  hooks.auto = { status: "loading" };
  hooks.seenAt = null;
  hooks.seenFor = [];
  // "Now" for the latest draft's date: only Date is faked.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/** The latest draft's date as the banner writes it: month and day, and the
 *  year only for another year. */
const shortDate = (iso: string, withYear: boolean) =>
  new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });

describe("DraftsBanner", () => {
  it("shows the count, the split by project and Review", () => {
    ready([
      draft({ proposal_id: "a1", created_at: "2026-11-01T09:00:00Z" }),
      draft({ proposal_id: "a2", created_at: "2026-11-03T15:30:00Z" }),
      draft({
        proposal_id: "b1",
        workspace_dir: B,
        created_at: "2026-11-02T08:00:00Z",
      }),
      // Decided drafts are history: no part of the count or the split.
      draft({ proposal_id: "a3", status: "rejected" }),
      draft({
        proposal_id: "b2",
        workspace_dir: B,
        status: "approved",
        approved_by: "auto",
        approved_at: "2026-11-04T00:00:00Z",
      }),
    ]);
    const view = banner();

    expect(screen.getByText("3 skills drafted from your memory")).toBeTruthy();
    expectNoParagraphGaps(view.container);
    expect(screen.getByText("EvoSci_test 2 · project_B 1")).toBeTruthy();
    // The latest draft's date (the spec's), its full time on hover.
    const latest = screen.getByText(
      `Latest ${shortDate(
        "2026-11-03T15:30:00Z",
        false
      )} · waiting for your review`
    );
    expect(latest.textContent).not.toContain("2026");
    expect(latest.getAttribute("title")).toBe(
      formatFullTime(new Date("2026-11-03T15:30:00Z"))
    );
    // Pending wins over the automatic installs.
    expect(screen.queryByText(/installed .* automatically/)).toBeNull();

    const review = screen.getByRole("button", { name: "Review" });
    expect(review.getAttribute("aria-describedby")).toBe(
      screen.getByText("3 skills drafted from your memory").id
    );
    fireEvent.click(review);
    expect(q.writes).toEqual(
      expect.arrayContaining([
        ["skillsPage", "drafts"],
        ["draftsTab", null],
        ["draftId", null],
      ])
    );

    // One draft reads as one; a draft from another year shows its year.
    ready([
      draft({
        proposal_id: "b1",
        workspace_dir: B,
        created_at: "2025-12-30T10:00:00Z",
      }),
    ]);
    view.rerender(
      <TestProjectsProvider value={mockProjects(readyProjects(A, B))}>
        <DraftsBanner />
      </TestProjectsProvider>
    );
    expect(screen.getByText("1 skill drafted from your memory")).toBeTruthy();
    expect(screen.getByText("project_B 1")).toBeTruthy();
    const older = screen.getByText(
      `Latest ${shortDate(
        "2025-12-30T10:00:00Z",
        true
      )} · waiting for your review`
    );
    expect(older.textContent).toContain("2025");
  });

  it("shows the automatic-install banner only for automatic approvals since last seen", () => {
    const auto = (id: string, at: string | null) =>
      draft({
        proposal_id: id,
        status: "approved",
        approved_by: "auto",
        approved_at: at,
      });
    const drafts = [
      auto("new-1", "2026-11-04T10:00:00Z"),
      auto("new-2", "2026-11-04T09:00:00.000+02:00"),
      auto("old", "2026-11-02T10:00:00Z"),
      // Without a time it can't be placed after the last visit.
      auto("no-time", null),
      auto("bad-time", "yesterday-ish"),
      // Approved by a person: never in this count.
      draft({
        proposal_id: "by-user",
        status: "approved",
        approved_by: "user",
        approved_at: "2026-11-04T11:00:00Z",
      }),
    ];
    ready(drafts);
    hooks.seenAt = "2026-11-03T00:00:00.000Z";
    const view = banner();

    expect(
      screen.getByText("AutoSkills installed 2 skills automatically")
    ).toBeTruthy();
    expectNoParagraphGaps(view.container);
    expect(hooks.seenFor).toContain(URL_);
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    const see = screen.getByRole("button", { name: "See them" });
    expect(see.getAttribute("aria-describedby")).toBe(
      screen.getByText("AutoSkills installed 2 skills automatically").id
    );
    fireEvent.click(see);
    expect(q.writes).toEqual(
      expect.arrayContaining([
        ["skillsPage", "drafts"],
        ["draftsTab", "approved"],
        ["draftId", null],
      ])
    );

    const again = () =>
      view.rerender(
        <TestProjectsProvider value={mockProjects(readyProjects(A, B))}>
          <DraftsBanner />
        </TestProjectsProvider>
      );

    // Nothing seen yet: every automatic install with a time counts.
    hooks.seenAt = null;
    again();
    expect(
      screen.getByText("AutoSkills installed 3 skills automatically")
    ).toBeTruthy();

    // One reads as one.
    hooks.seenAt = "2026-11-04T09:30:00Z";
    again();
    expect(
      screen.getByText("AutoSkills installed 1 skill automatically")
    ).toBeTruthy();

    // All of them seen: the history link instead.
    hooks.seenAt = "2026-11-05T00:00:00Z";
    again();
    expect(screen.queryByText(/automatically/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "AutoSkills history" })
    ).toBeTruthy();
  });

  it("shows AutoSkills history with nothing pending", () => {
    ready([
      draft({
        proposal_id: "x",
        status: "approved",
        approved_by: "user",
        approved_at: "2026-11-04T11:00:00Z",
      }),
      draft({ proposal_id: "y", status: "rejected" }),
    ]);
    banner();

    expect(screen.queryByText(/drafted from your memory/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "AutoSkills history" }));
    expect(q.writes).toEqual(
      expect.arrayContaining([
        ["skillsPage", "drafts"],
        ["draftsTab", "approved"],
        ["draftId", null],
      ])
    );
  });

  it("shows AutoSkills settings on an old core", () => {
    hooks.auto = { status: "unsupported" };
    banner();

    expect(screen.queryByText(/drafted from your memory/)).toBeNull();
    expect(screen.queryByRole("button", { name: "AutoSkills history" })).toBe(
      null
    );
    fireEvent.click(
      screen.getByRole("button", { name: "AutoSkills settings" })
    );
    expect(q.writes).toEqual([
      ["skillsPage", "drafts"],
      ["draftsTab", null],
    ]);
  });

  it("shows nothing while the drafts load or after a failed read", () => {
    const view = banner();
    expect(view.container.innerHTML).toBe("");

    hooks.auto = { status: "error", error: new Error("HTTP 500") };
    view.rerender(
      <TestProjectsProvider value={mockProjects(readyProjects(A, B))}>
        <DraftsBanner />
      </TestProjectsProvider>
    );
    expect(view.container.innerHTML).toBe("");
  });
});
