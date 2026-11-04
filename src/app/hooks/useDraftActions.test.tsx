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

const okApprove = { approved: true };
const okRevert = { reverted: true, status: "pending" };

function setup() {
  return renderHook(() => useDraftActions(projects));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useDraftActions", () => {
  it("approves each draft with its own scope", async () => {
    stubFetch([
      [200, okApprove],
      [200, okApprove],
    ]);
    const { result } = setup();
    const a = draft({ proposal_id: "a", scope: "workspace" });
    const b = draft({ proposal_id: "b", scope: "global" });
    await act(async () => {
      await result.current.approve([a, b], { a: "global" });
    });
    expect(calls).toEqual([
      { action: "approve", proposal_id: "a", scope: "global" },
      { action: "approve", proposal_id: "b", scope: "global" },
    ]);
    // Without a pick, the recorded scope goes out.
    stubFetch([[200, okApprove]]);
    await act(async () => {
      await result.current.approve([a]);
    });
    expect(calls).toEqual([
      { action: "approve", proposal_id: "a", scope: "workspace" },
    ]);
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
    expect(toast.error).toHaveBeenCalledWith(
      "x was already decided elsewhere."
    );
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
    expect(toast.error).toHaveBeenCalledWith(
      "project_B isn't served by this backend right now, so t wasn't changed."
    );
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
    expect(toast.error).toHaveBeenCalledWith(
      "a changed since it was installed, so it stays installed."
    );
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
    expect(toast.error).toHaveBeenCalledWith("a is already back in Pending.");
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
    expect(calls).toEqual([{ action: "reject", proposal_id: "r" }]);
    expect(toast.success).toHaveBeenCalledWith(
      "Rejected r.",
      expect.objectContaining({ duration: 10_000 })
    );
  });
});

describe("decisionToast", () => {
  const w = (id: string, dir = A) =>
    draft({ proposal_id: id, workspace_dir: dir });
  it("words each case", () => {
    expect(decisionToast("approve", [w("a")], {}, labels)).toBe(
      "Installed a into EvoSci_test/skills."
    );
    expect(decisionToast("approve", [w("a")], { a: "global" }, labels)).toBe(
      "Installed a into all projects (global)."
    );
    expect(decisionToast("approve", [w("a", B), w("b", B)], {}, labels)).toBe(
      "Installed 2 skills into project_B/skills."
    );
    expect(
      decisionToast(
        "approve",
        [w("a"), w("b", B)],
        { a: "global", b: "global" },
        labels
      )
    ).toBe("Installed 2 skills into all projects (global).");
    expect(decisionToast("approve", [w("a"), w("b", B)], {}, labels)).toBe(
      "Installed 2 skills."
    );
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
