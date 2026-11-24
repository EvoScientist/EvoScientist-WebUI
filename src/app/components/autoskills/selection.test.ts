import { describe, expect, it } from "vitest";
import type { Draft, DraftList } from "@/lib/autoskills";
import { asSelected, decidable, stillListed, stillPending } from "./selection";
import type { Pick } from "./selection";

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
    content_digest: null,
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

const x = draft({ proposal_id: "x", updated_at: "T-x" });
const y = draft({ proposal_id: "y", updated_at: "T-y" });
const z = draft({ proposal_id: "z", updated_at: "T-z", workspace_dir: B });

/** A pick: the updated_at recorded, and the digest when the test cares. */
const pick = (
  updated_at: string,
  content_digest: string | null = null
): Pick => ({
  updated_at,
  content_digest,
});

describe("stillPending", () => {
  it("keeps the picks still pending, in a registered project once known, with their stamps", () => {
    const list = listOf([x, { ...y, status: "approved" }, z]);
    const picked = new Map([
      ["x", pick("T-x")],
      ["y", pick("T-y")],
      ["z", pick("T-z")],
    ]);
    expect([...stillPending(picked, list, null)]).toEqual([
      ["x", pick("T-x")],
      ["z", pick("T-z")],
    ]);
    expect([...stillPending(picked, list, new Set([B]))]).toEqual([
      ["z", pick("T-z")],
    ]);
  });

  it("keeps the digest each draft was picked at, though the list has another", () => {
    // An agent's plain file write changes a pending draft's files, and its
    // content_digest, without its updated_at: the pick's digest stays.
    const picked = new Map([["x", pick("T-x", "d-1")]]);
    const relisted = { ...x, content_digest: "d-2" };
    expect([...stillPending(picked, listOf([relisted]), null)]).toEqual([
      ["x", pick("T-x", "d-1")],
    ]);
  });

  it("returns the same selection when nothing drops", () => {
    const picked = new Map([["x", pick("T-x")]]);
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
        ["x", pick("T1")],
        ["z", pick("T1z")],
      ])
    );
    expect(out).toEqual([{ ...listed, updated_at: "T1" }, kept]);
    // Not rewritten since the pick: the listed draft itself.
    expect(out[1]).toBe(kept);
  });

  it("sends each draft the digest it was picked at", () => {
    // The same stamp: an agent wrote a file in place, so the list has a new
    // digest for the same version. The pick vouches for what was read then.
    const listed = { ...x, content_digest: "d-2" };
    const out = asSelected([listed], new Map([["x", pick("T-x", "d-1")]]));
    expect(out).toEqual([{ ...listed, content_digest: "d-1" }]);
    // Still as it was picked: the listed draft itself.
    const same = { ...x, content_digest: "d-1" };
    expect(asSelected([same], new Map([["x", pick("T-x", "d-1")]]))[0]).toBe(
      same
    );
  });

  it("sends a draft with no pick recorded as listed", () => {
    expect(asSelected([x], new Map())[0]).toBe(x);
  });
});

describe("stillListed", () => {
  it("keeps a decision's drafts still pending, in a registered project once known, as the decision holds them", () => {
    const list = listOf([
      { ...x, updated_at: "T2" },
      { ...y, status: "approved" },
      z,
    ]);
    // x as picked at T1 stays as the decision holds it.
    const picked = { ...x, updated_at: "T1" };
    expect(stillListed([picked, y, z], list, null)).toEqual([picked, z]);
    expect(stillListed([picked, y, z], list, new Set([B]))).toEqual([z]);
    expect(stillListed([picked], null, null)).toEqual([]);
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
