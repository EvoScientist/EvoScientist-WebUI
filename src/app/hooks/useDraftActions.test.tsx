// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft } from "@/lib/autoskills";
import type { Project } from "@/lib/projects";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const refresh = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/app/hooks/useAutoSkills", () => ({ refreshAutoSkills: refresh }));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/app/hooks/useTeams", () => ({ notifyTeamsChanged: notify }));

import {
  type DecisionResult,
  decisionError,
  decisionToast,
  useDraftActions,
} from "./useDraftActions";

const A = "/work/EvoSci_test";
const B = "/work/project_B";
const projects: Project[] = [
  { key: A, name: "EvoSci_test", missing: false },
  { key: B, name: "project_B", missing: false },
];
const labels = new Map([
  [A, "EvoSci_test"],
  [B, "project_B"],
]);

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
    created_at: "",
    updated_at: "",
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

function reply(status: number, body: Record<string, unknown>) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

let calls: Array<Record<string, unknown>>;
function stubFetch(answers: Array<[number, Record<string, unknown>]>) {
  calls = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      const [status, body] = answers[i++];
      return reply(status, body);
    })
  );
}

// The core's answer names where it installed the skill.
const okApprove = { approved: true, scope: "workspace" };
const okGlobal = { approved: true, scope: "global" };
const okRevert = { reverted: true, status: "pending" };

/** The lines of the last error toast's title node. */
function errorLines(): string[] {
  const node = toast.error.mock.calls.at(-1)?.[0] as {
    props: { children: Array<{ props: { children: string } }> };
  };
  return node.props.children.map((c) => c.props.children);
}

function setup() {
  return renderHook(() => useDraftActions(projects));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useDraftActions", () => {
  it("sends a picked scope, and null for a draft without one", async () => {
    stubFetch([
      [200, okGlobal],
      [200, okGlobal],
    ]);
    const { result } = setup();
    const a = draft({ proposal_id: "a", scope: "workspace" });
    const b = draft({ proposal_id: "b", scope: "global" });
    await act(async () => {
      await result.current.approve([a, b], { a: "global" });
    });
    // The list's recorded scope may be stale (a draft resubmitted with
    // another one): without a pick the core installs where it records now.
    expect(calls).toEqual([
      {
        action: "approve",
        proposal_id: "a",
        scope: "global",
        expected_updated_at: null,
      },
      {
        action: "approve",
        proposal_id: "b",
        scope: null,
        expected_updated_at: null,
      },
    ]);
  });

  it("every approve sends the draft's updated_at as the page read it", async () => {
    stubFetch([
      [200, okGlobal],
      [200, okApprove],
      [200, okApprove],
    ]);
    const { result } = setup();
    const a = draft({ proposal_id: "a", updated_at: "2026-11-06T09:00:00Z" });
    const b = draft({ proposal_id: "b", updated_at: "2026-11-06T10:00:00Z" });
    // Read without one: nothing to check against.
    const c = draft({ proposal_id: "c", updated_at: "" });
    // The pane's approve, with the scope it shows.
    await act(async () => {
      await result.current.approve([a], { a: "global" });
    });
    // A bulk approve: each draft as the list has it, no scopes.
    await act(async () => {
      await result.current.approve([b, c]);
    });
    expect(calls).toEqual([
      {
        action: "approve",
        proposal_id: "a",
        scope: "global",
        expected_updated_at: "2026-11-06T09:00:00Z",
      },
      {
        action: "approve",
        proposal_id: "b",
        scope: null,
        expected_updated_at: "2026-11-06T10:00:00Z",
      },
      {
        action: "approve",
        proposal_id: "c",
        scope: null,
        expected_updated_at: null,
      },
    ]);
  });

  it("a bulk approve sends no scope at all", async () => {
    stubFetch([
      [200, okApprove],
      [200, okGlobal],
      [200, okApprove],
    ]);
    const { result } = setup();
    await act(async () => {
      await result.current.approve([
        draft({ proposal_id: "a", scope: "workspace" }),
        draft({ proposal_id: "b", scope: "global" }),
        // A valid skill name that is also an Object.prototype key.
        draft({ proposal_id: "constructor", scope: "workspace" }),
      ]);
    });
    expect(calls).toEqual(
      ["a", "b", "constructor"].map((id) => ({
        action: "approve",
        proposal_id: id,
        scope: null,
        expected_updated_at: null,
      }))
    );
  });

  it("the toast names where the core installed it, not the list's scope", async () => {
    const { result } = setup();
    stubFetch([[200, okGlobal]]);
    await act(async () => {
      await result.current.approve([
        draft({ proposal_id: "a", scope: "workspace" }),
      ]);
    });
    expect(toast.success.mock.calls[0][0]).toBe(
      "Installed a into all projects (global)."
    );

    stubFetch([[200, okApprove]]);
    await act(async () => {
      await result.current.approve([
        draft({ proposal_id: "b", scope: "global" }),
      ]);
    });
    expect(toast.success.mock.calls[1][0]).toBe(
      "Installed b into EvoSci_test/skills."
    );

    // Several: by their answers.
    stubFetch([
      [200, okGlobal],
      [200, okGlobal],
    ]);
    await act(async () => {
      await result.current.approve([
        draft({ proposal_id: "c", scope: "workspace" }),
        draft({ proposal_id: "d", scope: "workspace", workspace_dir: B }),
      ]);
    });
    expect(toast.success.mock.calls[2][0]).toBe(
      "Installed 2 skills into all projects (global)."
    );
    stubFetch([
      [200, okApprove],
      [200, okApprove],
    ]);
    await act(async () => {
      await result.current.approve([
        draft({ proposal_id: "e", scope: "global", workspace_dir: B }),
        draft({ proposal_id: "f", scope: "global", workspace_dir: B }),
      ]);
    });
    expect(toast.success.mock.calls[3][0]).toBe(
      "Installed 2 skills into project_B/skills."
    );
  });

  it("an answer without a scope names the place only when it was picked", async () => {
    const { result } = setup();
    stubFetch([[200, { approved: true }]]);
    await act(async () => {
      await result.current.approve([draft({ proposal_id: "a" })]);
    });
    expect(toast.success.mock.calls[0][0]).toBe("Installed a.");

    stubFetch([[200, { approved: true }]]);
    await act(async () => {
      await result.current.approve([draft({ proposal_id: "b" })], {
        b: "global",
      });
    });
    expect(toast.success.mock.calls[1][0]).toBe(
      "Installed b into all projects (global)."
    );
  });

  it("a single approval toasts where it went with Undo", async () => {
    stubFetch([[200, okApprove]]);
    const { result } = setup();
    const d = draft({ proposal_id: "arxiv-paper-retrieval" });
    await act(async () => {
      await result.current.approve([d]);
    });
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(
      "Installed arxiv-paper-retrieval into EvoSci_test/skills.",
      expect.objectContaining({
        duration: 10_000,
        action: expect.objectContaining({ label: "Undo" }),
      })
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("an update approval gets no Undo", async () => {
    stubFetch([[200, okApprove]]);
    const { result } = setup();
    const d = draft({ proposal_id: "u", operation: "update" });
    await act(async () => {
      await result.current.approve([d]);
    });
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success.mock.calls[0]).toEqual([
      "Installed u into EvoSci_test/skills.",
    ]);
  });

  it("Undo follows the operation the core answered, not the list's", async () => {
    const { result } = setup();
    // Read as a new skill, approved as an update (rewritten meanwhile): the
    // core keeps no backup, so no Undo.
    stubFetch([[200, { ...okApprove, operation: "update" }]]);
    await act(async () => {
      await result.current.approve([
        draft({ proposal_id: "a", operation: "create" }),
      ]);
    });
    expect(toast.success.mock.calls[0]).toEqual([
      "Installed a into EvoSci_test/skills.",
    ]);

    // The other way round: Undo is offered, and reverts it.
    stubFetch([[200, { ...okApprove, operation: "create" }]]);
    await act(async () => {
      await result.current.approve([
        draft({ proposal_id: "b", operation: "update" }),
      ]);
    });
    const options = toast.success.mock.calls[1][1];
    expect(options).toEqual(
      expect.objectContaining({
        action: expect.objectContaining({ label: "Undo" }),
      })
    );
    stubFetch([[200, okRevert]]);
    await act(async () => {
      await options.action.onClick();
    });
    expect(calls).toEqual([{ action: "revert", proposal_id: "b" }]);
  });

  it("not_pending is reported per draft and gets no Undo", async () => {
    stubFetch([[409, { error: "not_pending", status: "approved" }]]);
    const { result } = setup();
    const d = draft({ proposal_id: "x" });
    let out;
    await act(async () => {
      out = await result.current.approve([d]);
    });
    expect(out).toEqual({
      done: [],
      failed: [{ draft: d, message: "x was already decided elsewhere." }],
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(errorLines()).toEqual(["x was already decided elsewhere."]);
  });

  it("a draft changed since the page read it installs nothing and says so", async () => {
    stubFetch([
      [200, okApprove],
      [409, { error: "draft_changed", updated_at: "2026-11-06T11:00:00Z" }],
    ]);
    const { result } = setup();
    const a = draft({ proposal_id: "a" });
    const b = draft({ proposal_id: "b", skill_name: "data-cleaning" });
    let out: DecisionResult | undefined;
    await act(async () => {
      out = await result.current.approve([a, b]);
    });
    const line =
      "data-cleaning changed since the page read it, so nothing was installed. Read the new version, then decide.";
    // Not done (still pending), and marked so the page drops it from the
    // selection.
    expect(out).toEqual({
      done: [a],
      failed: [{ draft: b, message: line, changed: true }],
    });
    expect(errorLines()).toEqual([line]);
    expect(toast.success).toHaveBeenCalledWith(
      "Installed a into EvoSci_test/skills.",
      expect.objectContaining({ action: expect.anything() })
    );
    // The re-read brings its new version.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("every reject sends the draft's updated_at as the page read it, and no scope", async () => {
    stubFetch([
      [200, { rejected: true }],
      [200, { rejected: true }],
      [200, { rejected: true }],
    ]);
    const { result } = setup();
    const a = draft({ proposal_id: "a", updated_at: "2026-11-06T09:00:00Z" });
    const b = draft({
      proposal_id: "b",
      scope: "global",
      updated_at: "2026-11-06T10:00:00.123Z",
    });
    // Read without one: nothing to check against.
    const c = draft({ proposal_id: "c", updated_at: "" });
    // The pane's reject: the draft it shows.
    await act(async () => {
      await result.current.reject([a]);
    });
    // A bulk reject: each draft as the page hands it over.
    await act(async () => {
      await result.current.reject([b, c]);
    });
    expect(calls).toEqual([
      {
        action: "reject",
        proposal_id: "a",
        expected_updated_at: "2026-11-06T09:00:00Z",
      },
      {
        action: "reject",
        proposal_id: "b",
        expected_updated_at: "2026-11-06T10:00:00.123Z",
      },
      { action: "reject", proposal_id: "c", expected_updated_at: null },
    ]);
  });

  it("a draft changed since the page read it is not rejected and says so", async () => {
    stubFetch([
      [200, { rejected: true }],
      [409, { error: "draft_changed", updated_at: "2026-11-06T11:00:00Z" }],
    ]);
    const { result } = setup();
    const a = draft({ proposal_id: "a" });
    const b = draft({ proposal_id: "b", skill_name: "data-cleaning" });
    let out: DecisionResult | undefined;
    await act(async () => {
      out = await result.current.reject([a, b]);
    });
    const line =
      "data-cleaning changed since the page read it, so it wasn't rejected. Read the new version, then decide.";
    // Not done (still pending), and marked so the page drops it from the
    // selection, as an approve's draft_changed.
    expect(out).toEqual({
      done: [a],
      failed: [{ draft: b, message: line, changed: true }],
    });
    expect(errorLines()).toEqual([line]);
    expect(toast.success).toHaveBeenCalledWith(
      "Rejected a.",
      expect.objectContaining({ action: expect.anything() })
    );
    // The re-read brings its new version.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("mixed bulk approve reports each draft", async () => {
    stubFetch([
      [200, okApprove],
      [200, okApprove],
      [409, { error: "project_not_served" }],
    ]);
    const { result } = setup();
    const create = draft({ proposal_id: "c", workspace_dir: A });
    const update = draft({
      proposal_id: "u",
      operation: "update",
      workspace_dir: B,
    });
    const third = draft({ proposal_id: "t", workspace_dir: B });
    await act(async () => {
      await result.current.approve([create, update, third]);
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Installed 2 skills.",
      expect.objectContaining({ action: expect.anything() })
    );
    expect(errorLines()).toEqual([
      "project_B isn't served by this backend right now, so t wasn't changed.",
    ]);
    stubFetch([[200, okRevert]]);
    const options = toast.success.mock.calls[0][1];
    await act(async () => {
      await options.action.onClick();
    });
    expect(calls).toEqual([{ action: "revert", proposal_id: "c" }]);
  });

  it("undo reverts the drafts it was given", async () => {
    stubFetch([
      [200, okApprove],
      [200, okApprove],
    ]);
    const { result } = setup();
    const a = draft({ proposal_id: "a" });
    const b = draft({ proposal_id: "b" });
    await act(async () => {
      await result.current.approve([a, b]);
    });
    expect(toast.success.mock.calls[0][0]).toBe(
      "Installed 2 skills into EvoSci_test/skills."
    );
    stubFetch([
      [200, okRevert],
      [200, okRevert],
    ]);
    const { action } = toast.success.mock.calls[0][1];
    await act(async () => {
      await action.onClick();
    });
    expect(calls).toEqual([
      { action: "revert", proposal_id: "a" },
      { action: "revert", proposal_id: "b" },
    ]);
    expect(toast.success).toHaveBeenLastCalledWith(
      "Moved 2 skills back to Pending."
    );
    // A second click does nothing.
    stubFetch([]);
    await act(async () => {
      await action.onClick();
    });
    expect(calls).toEqual([]);
    expect(toast.success).toHaveBeenCalledTimes(2);
  });

  it("undo reports skill_changed and keeps the rest reverted", async () => {
    stubFetch([
      [200, okApprove],
      [200, okApprove],
    ]);
    const { result } = setup();
    await act(async () => {
      await result.current.approve([
        draft({ proposal_id: "a" }),
        draft({ proposal_id: "b" }),
      ]);
    });
    stubFetch([
      [409, { error: "skill_changed" }],
      [200, okRevert],
    ]);
    await act(async () => {
      await toast.success.mock.calls[0][1].action.onClick();
    });
    expect(toast.success).toHaveBeenLastCalledWith("Moved b back to Pending.");
    expect(errorLines()).toEqual([
      "a changed since it was installed, so it stays installed.",
    ]);
  });

  it("undo says not_decided per draft", async () => {
    stubFetch([[200, okApprove]]);
    const { result } = setup();
    await act(async () => {
      await result.current.approve([draft({ proposal_id: "a" })]);
    });
    stubFetch([[409, { error: "not_decided" }]]);
    await act(async () => {
      await toast.success.mock.calls[0][1].action.onClick();
    });
    expect(errorLines()).toEqual(["a is already back in Pending."]);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("re-reads the drafts and the experts after a decision", async () => {
    stubFetch([[200, { rejected: true }]]);
    const { result } = setup();
    await act(async () => {
      await result.current.reject([draft({ proposal_id: "r" })]);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      { action: "reject", proposal_id: "r", expected_updated_at: null },
    ]);
    expect(toast.success).toHaveBeenCalledWith(
      "Rejected r.",
      expect.objectContaining({ duration: 10_000 })
    );
  });
});

describe("useDraftActions fixes", () => {
  it("a 2xx without the success flag is a failure", async () => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(calls.push({}) === 1 ? "OK" : "{}", { status: 200 })
        )
      )
    );
    const { result } = setup();
    const a = draft({ proposal_id: "a" });
    const b = draft({ proposal_id: "b" });
    let out;
    await act(async () => {
      out = await result.current.approve([a, b]);
    });
    expect(out).toEqual({
      done: [],
      failed: [
        { draft: a, message: "a couldn't be changed (HTTP 200)." },
        { draft: b, message: "b couldn't be changed (HTTP 200)." },
      ],
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(errorLines()).toEqual([
      "a couldn't be changed (HTTP 200).",
      "b couldn't be changed (HTTP 200).",
    ]);
  });

  it("a JSON null answer is a failure and the next draft still goes", async () => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          calls.push({}) === 1
            ? new Response("null", { status: 200 })
            : new Response(JSON.stringify({ approved: true }), { status: 200 })
        )
      )
    );
    const { result } = setup();
    const a = draft({ proposal_id: "a" });
    const b = draft({ proposal_id: "b" });
    let out: DecisionResult | undefined;
    await act(async () => {
      out = await result.current.approve([a, b]);
    });
    expect(calls).toHaveLength(2);
    expect(out).toEqual({
      done: [b],
      failed: [{ draft: a, message: "a couldn't be changed (HTTP 200)." }],
    });
  });

  it("a non-2xx null body gives the generic line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("null", { status: 409 })))
    );
    const { result } = setup();
    await act(async () => {
      await result.current.approve([draft({ proposal_id: "a" })]);
    });
    expect(errorLines()).toEqual(["a couldn't be changed (HTTP 409)."]);
  });

  it("each action needs its own flag", async () => {
    stubFetch([[200, { approved: true }]]);
    const { result } = setup();
    let out: DecisionResult | undefined;
    await act(async () => {
      out = await result.current.reject([draft({ proposal_id: "r" })]);
    });
    expect(out?.done).toEqual([]);
  });

  it("failures show one line each, identical lines once", async () => {
    stubFetch([
      [403, { error: "secret_rejected" }],
      [403, { error: "secret_rejected" }],
      [404, { error: "not_found" }],
    ]);
    const { result } = setup();
    await act(async () => {
      await result.current.approve([
        draft({ proposal_id: "a" }),
        draft({ proposal_id: "b" }),
        draft({ proposal_id: "c" }),
      ]);
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
    const lines = errorLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/local secret/);
    expect(lines[1]).toBe("c is no longer there.");
    expect(toast.error.mock.calls[0][1]).toBeUndefined();
  });

  it("toasts come out when the re-read rejects", async () => {
    refresh.mockRejectedValueOnce(new Error("down"));
    notify.mockImplementationOnce(() => {
      throw new Error("x");
    });
    stubFetch([[200, okApprove]]);
    const { result } = setup();
    let out: DecisionResult | undefined;
    await act(async () => {
      out = await result.current.approve([draft({ proposal_id: "a" })]);
    });
    expect(out?.done).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
    refresh.mockRejectedValueOnce(new Error("down"));
    stubFetch([[200, okRevert]]);
    await act(async () => {
      await toast.success.mock.calls[0][1].action.onClick();
    });
    expect(toast.success).toHaveBeenLastCalledWith("Moved a back to Pending.");
  });

  it("a re-read that never answers holds neither the toast nor busy", async () => {
    // The drafts GET has no timeout: a stalled one must not lock every
    // decision control or hold back the toast and its Undo.
    refresh.mockImplementation(() => new Promise<undefined>(() => {}));
    try {
      stubFetch([[200, okApprove]]);
      const { result } = setup();
      let settled = false;
      await act(async () => {
        void result.current
          .approve([draft({ proposal_id: "a" })])
          .then(() => (settled = true));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(settled).toBe(true);
      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(result.current.busy).toBe(false);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);

      // Undo the same way.
      stubFetch([[200, okRevert]]);
      let undone = false;
      await act(async () => {
        void toast.success.mock.calls[0][1].action
          .onClick()
          .then(() => (undone = true));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(undone).toBe(true);
      expect(toast.success).toHaveBeenLastCalledWith(
        "Moved a back to Pending."
      );
      expect(result.current.busy).toBe(false);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      refresh.mockImplementation(async () => undefined);
    }
  });

  it("a failure without detail says the generic line", () => {
    const d = draft({ proposal_id: "n" });
    for (const detail of [undefined, "  "]) {
      expect(
        decisionError(
          { status: 409, error: "approve_failed", detail },
          d,
          labels
        )
      ).toBe("n couldn't be changed (HTTP 409).");
    }
  });

  it("busy covers in-flight and overlapping calls", async () => {
    const pending: Array<(r: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((r) => pending.push(r)))
    );
    const { result } = setup();
    const ok = () =>
      new Response(JSON.stringify({ rejected: true }), { status: 200 });
    let p1: Promise<unknown>, p2: Promise<unknown>;
    act(() => {
      p1 = result.current.reject([draft({ proposal_id: "a" })]);
    });
    expect(result.current.busy).toBe(true);
    act(() => {
      p2 = result.current.reject([draft({ proposal_id: "b" })]);
    });
    await act(async () => {
      pending[0](ok());
      await p1;
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      pending[1](ok());
      await p2;
    });
    expect(result.current.busy).toBe(false);
    expect(toast.success).toHaveBeenCalledTimes(2);
  });

  it("a network failure is reported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fail")))
    );
    const { result } = setup();
    await act(async () => {
      await result.current.approve([draft({ proposal_id: "a" })]);
    });
    expect(errorLines()).toEqual([
      "The WebUI server did not answer. Nothing was changed.",
    ]);
  });

  it("a reject can be undone", async () => {
    stubFetch([[200, { rejected: true }]]);
    const { result } = setup();
    await act(async () => {
      await result.current.reject([draft({ proposal_id: "r" })]);
    });
    stubFetch([[200, okRevert]]);
    await act(async () => {
      await toast.success.mock.calls[0][1].action.onClick();
    });
    expect(calls).toEqual([{ action: "revert", proposal_id: "r" }]);
    expect(toast.success).toHaveBeenLastCalledWith("Moved r back to Pending.");
  });
});

describe("Undo tells the page", () => {
  it("which drafts a successful Undo moved back", async () => {
    const onReverted = vi.fn();
    stubFetch([
      [200, okApprove],
      [200, okApprove],
    ]);
    const { result } = renderHook(() =>
      useDraftActions(projects, { onReverted })
    );
    const a = draft({ proposal_id: "a" });
    const b = draft({ proposal_id: "b" });
    await act(async () => {
      await result.current.approve([a, b]);
    });
    expect(onReverted).not.toHaveBeenCalled();
    stubFetch([
      [409, { error: "skill_changed" }],
      [200, okRevert],
    ]);
    await act(async () => {
      await toast.success.mock.calls[0][1].action.onClick();
    });
    expect(onReverted.mock.calls).toEqual([[[b], expect.any(Promise)]]);
  });

  it("with its own re-read, started first and settling when that read does", async () => {
    const onReverted = vi.fn();
    stubFetch([[200, okApprove]]);
    const { result } = renderHook(() =>
      useDraftActions(projects, { onReverted })
    );
    const a = draft({ proposal_id: "a" });
    await act(async () => {
      await result.current.approve([a]);
    });
    // The Undo's re-read stays out until settled here.
    let settle = () => {};
    refresh.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          settle = () => resolve(undefined);
        })
    );
    stubFetch([[200, okRevert]]);
    await act(async () => {
      await toast.success.mock.calls[0][1].action.onClick();
    });
    // Started before the page was told: the hold's release relies on it.
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.invocationCallOrder[1]).toBeLessThan(
      onReverted.mock.invocationCallOrder[0]
    );
    expect(onReverted.mock.calls[0][0]).toEqual([a]);
    const read = onReverted.mock.calls[0][1] as Promise<void>;
    let settled = false;
    void read.then(() => {
      settled = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(settled).toBe(false);
    settle();
    await act(async () => {
      await read;
    });
    expect(settled).toBe(true);
  });

  it("a re-read that fails still settles the Undo's promise", async () => {
    const onReverted = vi.fn();
    stubFetch([[200, okApprove]]);
    const { result } = renderHook(() =>
      useDraftActions(projects, { onReverted })
    );
    await act(async () => {
      await result.current.approve([draft({ proposal_id: "a" })]);
    });
    refresh.mockRejectedValueOnce(new Error("offline"));
    stubFetch([[200, okRevert]]);
    await act(async () => {
      await toast.success.mock.calls[0][1].action.onClick();
    });
    await expect(onReverted.mock.calls[0][1]).resolves.toBeUndefined();
  });

  it("nothing when no Undo succeeded", async () => {
    const onReverted = vi.fn();
    stubFetch([[200, okApprove]]);
    const { result } = renderHook(() =>
      useDraftActions(projects, { onReverted })
    );
    await act(async () => {
      await result.current.approve([draft({ proposal_id: "a" })]);
    });
    stubFetch([[409, { error: "not_decided" }]]);
    await act(async () => {
      await toast.success.mock.calls[0][1].action.onClick();
    });
    expect(onReverted).not.toHaveBeenCalled();
  });
});

// A revert answers where the draft went: back to pending, or to rejected
// (an approval auto mode made). The toast follows the answer.
describe("Undo says where the core moved the drafts", () => {
  async function approved(ids: string[]) {
    stubFetch(ids.map(() => [200, okApprove]));
    const { result } = setup();
    await act(async () => {
      await result.current.approve(ids.map((id) => draft({ proposal_id: id })));
    });
    return toast.success.mock.calls[0][1].action.onClick as () => Promise<void>;
  }
  const toRejected = { reverted: true, status: "rejected" };

  it("one draft the core moved to rejected", async () => {
    const undo = await approved(["a"]);
    stubFetch([[200, toRejected]]);
    await act(async () => {
      await undo();
    });
    expect(toast.success).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenLastCalledWith("Moved a to Rejected.");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("several the core moved to rejected", async () => {
    const undo = await approved(["a", "b"]);
    stubFetch([
      [200, toRejected],
      [200, toRejected],
    ]);
    await act(async () => {
      await undo();
    });
    expect(toast.success).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenLastCalledWith(
      "Moved 2 skills to Rejected."
    );
  });

  it("a batch with both gets a toast for each", async () => {
    const undo = await approved(["a", "b", "c"]);
    stubFetch([
      [200, toRejected],
      [200, okRevert],
      [200, toRejected],
    ]);
    await act(async () => {
      await undo();
    });
    expect(toast.success.mock.calls.slice(1)).toEqual([
      ["Moved b back to Pending."],
      ["Moved 2 skills to Rejected."],
    ]);
  });

  it("an answer without a status, or with another one, reads as pending", async () => {
    const undo = await approved(["a", "b"]);
    stubFetch([
      [200, { reverted: true }],
      [200, { reverted: true, status: "approved" }],
    ]);
    await act(async () => {
      await undo();
    });
    expect(toast.success).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenLastCalledWith(
      "Moved 2 skills back to Pending."
    );
  });

  it("the page hears every draft the Undo moved, wherever it went", async () => {
    const onReverted = vi.fn();
    stubFetch([
      [200, okApprove],
      [200, okApprove],
    ]);
    const { result } = renderHook(() =>
      useDraftActions(projects, { onReverted })
    );
    const a = draft({ proposal_id: "a" });
    const b = draft({ proposal_id: "b" });
    await act(async () => {
      await result.current.approve([a, b]);
    });
    stubFetch([
      [200, toRejected],
      [200, okRevert],
    ]);
    await act(async () => {
      await toast.success.mock.calls[0][1].action.onClick();
    });
    // Both changed in the core, so the page holds both until the next list.
    expect(onReverted.mock.calls).toEqual([[[a, b], expect.any(Promise)]]);
  });
});

describe("Undo after revert_failed", () => {
  async function approved() {
    stubFetch([
      [200, okApprove],
      [200, okApprove],
    ]);
    const { result } = setup();
    await act(async () => {
      await result.current.approve([
        draft({ proposal_id: "a" }),
        draft({ proposal_id: "b" }),
      ]);
    });
    return toast.success.mock.calls[0][1].action.onClick as () => Promise<void>;
  }
  const LINE =
    "a couldn't be moved back to Pending: a file is in use. Try Undo again in a moment.";

  it("offers Undo again for the draft that was in use", async () => {
    const undo = await approved();
    stubFetch([
      [409, { error: "revert_failed", detail: "busy" }],
      [200, okRevert],
    ]);
    await act(async () => {
      await undo();
    });
    expect(toast.success).toHaveBeenLastCalledWith("Moved b back to Pending.");
    expect(errorLines()).toEqual([LINE]);
    expect(toast.error.mock.calls[0][1]).toEqual({
      duration: 10_000,
      action: expect.objectContaining({ label: "Undo" }),
    });
  });

  it("the retry reverts only that draft, once", async () => {
    const undo = await approved();
    stubFetch([
      [409, { error: "revert_failed", detail: "busy" }],
      [200, okRevert],
    ]);
    await act(async () => {
      await undo();
    });
    const retry = toast.error.mock.calls[0][1].action.onClick;
    stubFetch([[200, okRevert]]);
    await act(async () => {
      await retry();
    });
    expect(calls).toEqual([{ action: "revert", proposal_id: "a" }]);
    expect(toast.success).toHaveBeenLastCalledWith("Moved a back to Pending.");
    stubFetch([]);
    await act(async () => {
      await retry();
    });
    expect(calls).toEqual([]);
  });

  it("a second revert_failed offers Undo again", async () => {
    const undo = await approved();
    stubFetch([
      [409, { error: "revert_failed" }],
      [200, okRevert],
    ]);
    await act(async () => {
      await undo();
    });
    stubFetch([[409, { error: "revert_failed" }]]);
    await act(async () => {
      await toast.error.mock.calls[0][1].action.onClick();
    });
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.error.mock.calls[1][1].action.label).toBe("Undo");
  });

  it("an undo error without revert_failed has no action", async () => {
    const undo = await approved();
    stubFetch([
      [409, { error: "skill_changed" }],
      [409, { error: "not_decided" }],
    ]);
    await act(async () => {
      await undo();
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0]).toHaveLength(1);
  });
});

// A revert the page can't tell reached the core (the fetch to the WebUI
// server rejected, or the relay could not reach or wait for the backend)
// must not spend the Undo: nothing else in the page moves a decided draft
// back.
describe("Undo after a failure that may not have reached the core", () => {
  /** a and b approved; the Undo of that toast. */
  async function approved() {
    stubFetch([
      [200, okApprove],
      [200, okApprove],
    ]);
    const { result } = setup();
    await act(async () => {
      await result.current.approve([
        draft({ proposal_id: "a" }),
        draft({ proposal_id: "b" }),
      ]);
    });
    return toast.success.mock.calls[0][1].action.onClick as () => Promise<void>;
  }
  /** The reverts answer in turn: `[status, body]`, or "network" for a
   *  fetch that rejects. */
  function stubReverts(
    answers: Array<[number, Record<string, unknown>] | "network">
  ) {
    calls = [];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)));
        const next = answers[i++];
        return next === "network"
          ? Promise.reject(new TypeError("Failed to fetch"))
          : reply(next[0], next[1]);
      })
    );
  }

  it.each([
    ["the fetch rejected", "network" as const],
    [
      "the backend did not answer in time",
      [504, { error: "backend_timeout" }] as [number, Record<string, unknown>],
    ],
    [
      "the backend could not be reached",
      [502, { error: "backend_unreachable" }] as [
        number,
        Record<string, unknown>
      ],
    ],
  ])("offers Undo again when %s", async (_label, failure) => {
    const undo = await approved();
    stubReverts([[200, okRevert], failure]);
    await act(async () => {
      await undo();
    });
    expect(toast.success).toHaveBeenLastCalledWith("Moved a back to Pending.");
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0][1]).toEqual({
      duration: 10_000,
      action: expect.objectContaining({ label: "Undo" }),
    });

    // The retry reverts only the draft that failed, once.
    const retry = toast.error.mock.calls[0][1].action.onClick;
    stubReverts([[200, okRevert]]);
    await act(async () => {
      await retry();
    });
    expect(calls).toEqual([{ action: "revert", proposal_id: "b" }]);
    expect(toast.success).toHaveBeenLastCalledWith("Moved b back to Pending.");
    stubReverts([]);
    await act(async () => {
      await retry();
    });
    expect(calls).toEqual([]);
  });

  it("a retry of a revert that did reach the core says it is already back", async () => {
    const undo = await approved();
    stubReverts([[200, okRevert], "network"]);
    await act(async () => {
      await undo();
    });
    stubReverts([[409, { error: "not_decided" }]]);
    await act(async () => {
      await toast.error.mock.calls[0][1].action.onClick();
    });
    expect(errorLines()).toEqual(["b is already back in Pending."]);
    // Nothing left to retry.
    expect(toast.error.mock.calls[1]).toHaveLength(1);
  });

  it("a second such failure offers Undo again", async () => {
    const undo = await approved();
    stubReverts([[200, okRevert], "network"]);
    await act(async () => {
      await undo();
    });
    stubReverts([[504, { error: "backend_timeout" }]]);
    await act(async () => {
      await toast.error.mock.calls[0][1].action.onClick();
    });
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.error.mock.calls[1][1].action.label).toBe("Undo");
  });

  it("a refusal that a retry can't change offers none", async () => {
    const undo = await approved();
    stubReverts([
      [200, okRevert],
      [403, { error: "secret_rejected" }],
    ]);
    await act(async () => {
      await undo();
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0]).toHaveLength(1);
  });
});

describe("decisionToast", () => {
  const w = (id: string, dir = A) =>
    draft({ proposal_id: id, workspace_dir: dir });
  // The places come from the core's answers; the drafts' recorded scopes
  // ("workspace" here) don't count.
  it("words each case", () => {
    expect(decisionToast("approve", [w("a")], { a: "workspace" }, labels)).toBe(
      "Installed a into EvoSci_test/skills."
    );
    expect(decisionToast("approve", [w("a")], { a: "global" }, labels)).toBe(
      "Installed a into all projects (global)."
    );
    expect(decisionToast("approve", [w("a")], {}, labels)).toBe("Installed a.");
    expect(
      decisionToast(
        "approve",
        [w("a", B), w("b", B)],
        { a: "workspace", b: "workspace" },
        labels
      )
    ).toBe("Installed 2 skills into project_B/skills.");
    expect(
      decisionToast(
        "approve",
        [w("a"), w("b", B)],
        { a: "global", b: "global" },
        labels
      )
    ).toBe("Installed 2 skills into all projects (global).");
    expect(
      decisionToast(
        "approve",
        [w("a"), w("b", B)],
        { a: "workspace", b: "workspace" },
        labels
      )
    ).toBe("Installed 2 skills.");
    expect(
      decisionToast("approve", [w("a"), w("b")], { a: "workspace" }, labels)
    ).toBe("Installed 2 skills.");
    expect(decisionToast("reject", [w("a")], {}, labels)).toBe("Rejected a.");
    expect(decisionToast("reject", [w("a"), w("b")], {}, labels)).toBe(
      "Rejected 2 skills."
    );
  });
});

describe("decisionError", () => {
  const d = draft({ proposal_id: "n" });
  it("words each answer", () => {
    expect(decisionError({ status: 404, error: "not_found" }, d, labels)).toBe(
      "n is no longer there."
    );
    expect(
      decisionError({ status: 409, error: "draft_changed" }, d, labels)
    ).toBe(
      "n changed since the page read it, so nothing was installed. Read the new version, then decide."
    );
    expect(
      decisionError(
        { status: 409, error: "draft_changed" },
        d,
        labels,
        "reject"
      )
    ).toBe(
      "n changed since the page read it, so it wasn't rejected. Read the new version, then decide."
    );
    expect(
      decisionError(
        { status: 409, error: "approve_failed", detail: "boom" },
        d,
        labels
      )
    ).toBe("n: boom");
    expect(
      decisionError(
        { status: 409, error: "reject_failed", detail: "bang" },
        d,
        labels
      )
    ).toBe("n: bang");
    expect(decisionError("network", d, labels)).toBe(
      "The WebUI server did not answer. Nothing was changed."
    );
    expect(decisionError({ status: 500 }, d, labels)).toBe(
      "n couldn't be changed (HTTP 500)."
    );
    const secret = decisionError(
      { status: 403, error: "secret_rejected" },
      d,
      labels
    );
    expect(secret).toMatch(/local secret/);
    expect(
      decisionError({ status: 403, error: "local_secret_required" }, d, labels)
    ).toBe(secret);
    expect(decisionError({ status: 400, error: "toString" }, d, labels)).toBe(
      "n couldn't be changed (HTTP 400)."
    );
  });
});
