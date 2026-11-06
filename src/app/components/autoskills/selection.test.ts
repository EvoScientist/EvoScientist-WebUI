import { describe, expect, it } from "vitest";
import type { Draft, DraftList } from "@/lib/autoskills";
import { asSelected, decidable, stillPending } from "./selection";

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

function listOf(drafts: Draft[]): DraftList {
  return {
    drafts,
    counts: { pending: 0, approved: 0, rejected: 0 },
    byProject: {},
  };
}

const x = draft({ proposal_id: "x" });
const y = draft({ proposal_id: "y" });
const z = draft({ proposal_id: "z", workspace_dir: B });

describe("stillPending", () => {
  it("keeps the picks still pending, in a registered project once known, with their stamps", () => {
    const list = listOf([x, { ...y, status: "approved" }, z]);
    const picked = new Map([
      ["x", "T-x"],
      ["y", "T-y"],
      ["z", "T-z"],
    ]);
    expect([...stillPending(picked, list, null)]).toEqual([
      ["x", "T-x"],
      ["z", "T-z"],
    ]);
    expect([...stillPending(picked, list, new Set([B]))]).toEqual([
      ["z", "T-z"],
    ]);
  });

  it("returns the same selection when nothing drops", () => {
    const picked = new Map([["x", "T-x"]]);
    expect(stillPending(picked, listOf([x]), new Set([A]))).toBe(picked);
  });
});

describe("asSelected", () => {
  it("sends each draft at the version it was picked at", () => {
    // Picked at T1; a resubmit rewrote it since, and the list says T2.
    const listed = { ...x, updated_at: "T2" };
    const kept = { ...z, updated_at: "T1z" };
    const out = asSelected(
      [listed, kept],
      new Map([
        ["x", "T1"],
        ["z", "T1z"],
      ])
    );
    expect(out).toEqual([{ ...listed, updated_at: "T1" }, kept]);
    // Not rewritten since the pick: the listed draft itself.
    expect(out[1]).toBe(kept);
  });

  it("sends a draft with no stamp recorded as listed", () => {
    expect(asSelected([x], new Map())[0]).toBe(x);
  });
});

describe("decidable", () => {
  it("sends only drafts still pending and in a registered project", () => {
    const list = listOf([x, { ...y, status: "rejected" }, z]);
    expect(decidable([x, y, z], list, new Set([A, B]))).toEqual([x, z]);
    // z's project left between the render and the click.
    expect(decidable([x, y, z], list, new Set([A]))).toEqual([x]);
  });

  it("sends nothing while the projects or the drafts aren't known", () => {
    expect(decidable([x], listOf([x]), null)).toEqual([]);
    expect(decidable([x], null, new Set([A]))).toEqual([]);
  });
});
