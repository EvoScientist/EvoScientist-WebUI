// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTask } from "@/app/hooks/useScheduledTasks";
import { workspaceAssistantId } from "@/lib/workspaceAssistant";
import {
  TestProjectsProvider,
  mockProjects,
  readyProjects,
} from "@/test/mockProjects";

const listed = vi.hoisted(() => ({ tasks: [] as ScheduledTask[] }));

vi.mock("@/app/hooks/useScheduledTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/hooks/useScheduledTasks")>()),
  listScheduledTasks: vi.fn(async () => listed.tasks),
}));
vi.mock("@/app/hooks/useThreads", () => ({
  useThreads: () => ({ data: [] }),
}));
vi.mock("@/app/hooks/useProjectFiles", () => ({
  useProjectFiles: () => ({ project: null }),
}));

import { ResearchDashboard } from "./ResearchDashboard";

const A = "/home/you/projA";
const B = "/srv/projB";
const C = "/gone/projC";

const taskOn = (key: string) =>
  ({
    cron_id: "cron-1",
    assistantId: workspaceAssistantId("scheduler", key),
  } as ScheduledTask);

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResearchDashboard", () => {
  it("counts a moved project's scheduled tasks under its new folder", async () => {
    listed.tasks = [taskOn(C)];
    const dashboard = (
      <ResearchDashboard
        onNavigate={vi.fn()}
        onOpenThread={vi.fn()}
      />
    );
    const { rerender } = render(
      <TestProjectsProvider
        value={mockProjects(
          readyProjects(A, B, { key: C, name: "projC", missing: true }),
          { current: A }
        )}
      >
        {dashboard}
      </TestProjectsProvider>
    );
    await screen.findByRole("button", { name: /^Scheduled: 1\./ });

    listed.tasks = [taskOn(B)];
    rerender(
      <TestProjectsProvider
        value={{
          ...mockProjects(readyProjects(A, B), { current: A }),
          arrivedMoves: [{ from: C, to: B }],
        }}
      >
        {dashboard}
      </TestProjectsProvider>
    );

    expect(
      await screen.findByRole("button", { name: /^Scheduled: 1\./ })
    ).toBeTruthy();
  });
});
