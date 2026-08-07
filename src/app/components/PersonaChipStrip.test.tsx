// @vitest-environment jsdom
//
// PersonaChipStrip renders one chip per union entry of invited teams and
// dispatched async tasks, routes clicks correctly, and stays quiet when the
// union is empty. Composition tests for the ChatInterface-integration (submit
// blocked while focused, pill click clears focus) rely on the tsc + lint gate
// and the manual smoke checklist — the guard is a three-line early return.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { EnrichedAsyncTask } from "@/lib/asyncAgents";

// PersonaChipStrip calls useTeams(); mock it to avoid a real fetch.
vi.mock("@/app/hooks/useTeams", () => ({
  useTeams: () => ({
    teams: [
      {
        name: "idea-brainstorm",
        description: "Ideation team",
        avatar_hint: "lightbulb",
      },
    ],
    loaded: true,
    error: null,
    refresh: () => {},
  }),
}));

import { PersonaChipStrip } from "@/app/components/PersonaChipStrip";

function makeTask(over: Partial<EnrichedAsyncTask>): EnrichedAsyncTask {
  return {
    task_id: "task-1",
    agent_name: "idea-brainstorm",
    thread_id: "sub-thread-1",
    run_id: "run-1",
    status: "running",
    liveStatus: "running",
    startedAt: "2026-07-30T09:00:00Z",
    ...over,
  };
}

describe("PersonaChipStrip", () => {
  const noop = () => {};

  beforeEach(() => {
    // Nothing global; kept for symmetry with other test files.
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing when the union is empty", () => {
    const { container } = render(
      <PersonaChipStrip
        activeTeams={[]}
        tasks={[]}
        focusedAgentThreadId={null}
        onFocus={noop}
        onManage={noop}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders a chip for an invited-only team (no task)", () => {
    render(
      <PersonaChipStrip
        activeTeams={["idea-brainstorm"]}
        tasks={[]}
        focusedAgentThreadId={null}
        onFocus={noop}
        onManage={noop}
      />
    );
    const chip = screen.getByRole("button", { name: /Manage Idea Brainstorm/ });
    expect(chip).toBeDefined();
  });

  it("routes invited-only chip click to onManage (not onFocus)", async () => {
    const onFocus = vi.fn();
    const onManage = vi.fn();
    render(
      <PersonaChipStrip
        activeTeams={["idea-brainstorm"]}
        tasks={[]}
        focusedAgentThreadId={null}
        onFocus={onFocus}
        onManage={onManage}
      />
    );
    screen.getByRole("button", { name: /Manage Idea Brainstorm/ }).click();
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onFocus).not.toHaveBeenCalled();
  });

  it("routes dispatched chip click to onFocus with the sub-thread id", () => {
    const onFocus = vi.fn();
    const onManage = vi.fn();
    render(
      <PersonaChipStrip
        activeTeams={[]}
        tasks={[makeTask({ thread_id: "sub-thread-42" })]}
        focusedAgentThreadId={null}
        onFocus={onFocus}
        onManage={onManage}
      />
    );
    screen.getByRole("button", { name: /Focus Idea Brainstorm/ }).click();
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith("sub-thread-42");
    expect(onManage).not.toHaveBeenCalled();
  });

  it("picks the newest run when the same expert has multiple tasks", () => {
    // useAsyncAgents returns tasks newest-first. A naive forward .set() loop
    // would overwrite with progressively older tasks — regression-check that
    // the freshest run wins and the chip routes to its sub-thread.
    const onFocus = vi.fn();
    render(
      <PersonaChipStrip
        activeTeams={[]}
        tasks={[
          makeTask({
            task_id: "task-new",
            thread_id: "sub-new",
            liveStatus: "running",
          }),
          makeTask({
            task_id: "task-old",
            thread_id: "sub-old",
            liveStatus: "success",
          }),
        ]}
        focusedAgentThreadId={null}
        onFocus={onFocus}
        onManage={() => {}}
      />
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    buttons[0].click();
    expect(onFocus).toHaveBeenCalledWith("sub-new");
  });

  it("dedupes: a task supersedes the same team's invited-only entry", () => {
    render(
      <PersonaChipStrip
        activeTeams={["idea-brainstorm"]}
        tasks={[makeTask({ liveStatus: "success" })]}
        focusedAgentThreadId={null}
        onFocus={noop}
        onManage={noop}
      />
    );
    // Only one button — the task wins, chip is "Focus …" not "Manage …".
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("title")).toMatch(/Focus Idea Brainstorm/);
  });

  it("paints the dismissed chip with a grey dot and Dismissed suffix", () => {
    // Task exists (dispatched) but the persona is no longer in activeTeams —
    // the roster dismissed the expert; chip stays as a review affordance.
    const { container } = render(
      <PersonaChipStrip
        activeTeams={[]}
        tasks={[makeTask({ liveStatus: "success" })]}
        focusedAgentThreadId={null}
        onFocus={() => {}}
        onManage={() => {}}
      />
    );
    const chip = screen.getByRole("button", { name: /Focus Idea Brainstorm/ });
    expect(chip.getAttribute("aria-label")).toMatch(/Dismissed/);
    const dot = container.querySelector("span.rounded-full.ml-0\\.5");
    expect(dot?.className).toContain("bg-muted-foreground");
    expect(dot?.className ?? "").not.toContain("animate-pulse");
  });

  it("keeps the live status dot when the persona is still invited", () => {
    const { container } = render(
      <PersonaChipStrip
        activeTeams={["idea-brainstorm"]}
        tasks={[makeTask({ liveStatus: "running" })]}
        focusedAgentThreadId={null}
        onFocus={() => {}}
        onManage={() => {}}
      />
    );
    const dot = container.querySelector("span.rounded-full.ml-0\\.5");
    expect(dot?.className).toContain("bg-[var(--color-warning)]");
    expect(dot?.className).toContain("animate-pulse");
  });

  it("marks the focused chip with aria-pressed=true", () => {
    render(
      <PersonaChipStrip
        activeTeams={[]}
        tasks={[makeTask({ thread_id: "sub-thread-1" })]}
        focusedAgentThreadId="sub-thread-1"
        onFocus={() => {}}
        onManage={() => {}}
      />
    );
    const chip = screen.getByRole("button", {
      name: /Focused: Idea Brainstorm/,
    });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
  });
});
