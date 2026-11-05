import { describe, expect, it } from "vitest";

import {
  AUTOSKILLS_FIELDS,
  autoSkillsReadOnlyReason,
  bannerSummary,
  fromMemorySkills,
  groupDrafts,
  installedLabel,
  isProjectCopy,
  isRevertible,
  labelFor,
  parseDraftList,
  projectLabels,
  statusLine,
  type Draft,
  type DraftList,
} from "./autoskills";
import type { Project } from "./projects";
import type { SettingsWriteAccess } from "./settings";

function project(key: string, name?: string): Project {
  return {
    key,
    name: name ?? key.split("/").pop() ?? key,
    missing: false,
  };
}

function draft(over: Partial<Draft> = {}): Draft {
  return {
    proposal_id: "p1",
    skill_name: "alpha",
    description: "",
    operation: "create",
    target_skill_name: null,
    scope: "workspace",
    submitted_scope: null,
    status: "pending",
    workspace_dir: "/work/A",
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
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

function list(drafts: Draft[], byProject: DraftList["byProject"] = {}) {
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const d of drafts) counts[d.status] += 1;
  return { drafts, counts, byProject } satisfies DraftList;
}

describe("parseDraftList", () => {
  it("keeps well-formed drafts and drops the rest", () => {
    const parsed = parseDraftList({
      proposals: [
        {
          proposal_id: "a",
          skill_name: "s",
          workspace_dir: "/w",
          status: "approved",
          operation: "create",
          scope: "workspace",
          files: [{ path: "SKILL.md", size: 3, installed: true }, { size: 1 }],
        },
        {
          proposal_id: "bad-op",
          skill_name: "s",
          workspace_dir: "/w",
          status: "pending",
          operation: "delete",
          scope: "workspace",
        },
        {
          proposal_id: "bad-scope",
          skill_name: "s",
          workspace_dir: "/w",
          status: "pending",
          operation: "create",
          scope: "wrong",
        },
        {
          proposal_id: "no-op",
          skill_name: "s",
          workspace_dir: "/w",
          status: "pending",
          scope: "workspace",
        },
        {
          proposal_id: "no-scope",
          skill_name: "s",
          workspace_dir: "/w",
          status: "pending",
          operation: "update",
        },
        { proposal_id: "b", skill_name: "s", workspace_dir: "/w" },
        { proposal_id: "c", skill_name: "s", workspace_dir: "/w", status: "x" },
        { skill_name: "s", workspace_dir: "/w", status: "pending" },
        { proposal_id: "d", workspace_dir: "/w", status: "pending" },
        { proposal_id: "e", skill_name: "s", status: "pending" },
        null,
      ],
      counts: { pending: 0, approved: 1, rejected: 0 },
      by_project: { "/w": { pending: 0, approved: 1, rejected: 0 } },
    });
    expect(parsed?.drafts).toHaveLength(1);
    const d = parsed!.drafts[0];
    expect(d).toMatchObject({
      proposal_id: "a",
      description: "",
      operation: "create",
      target_skill_name: null,
      scope: "workspace",
      approved_by: null,
      approved_skill_present: null,
      source_observation_ids: [],
      skill_md: "",
      skill_md_truncated: false,
      install_error: null,
    });
    expect(d.files).toEqual([{ path: "SKILL.md", size: 3, installed: true }]);
    expect(parsed?.counts).toEqual({ pending: 0, approved: 1, rejected: 0 });
    expect(parsed?.byProject["/w"]).toEqual({
      pending: 0,
      approved: 1,
      rejected: 0,
    });
  });

  it("returns null without a proposals array", () => {
    expect(parseDraftList(null)).toBeNull();
    expect(parseDraftList({ counts: {} })).toBeNull();
    expect(parseDraftList({ proposals: {}, counts: {} })).toBeNull();
    expect(parseDraftList({ proposals: [] })).toBeNull();
  });
});

describe("parseDraftList counts", () => {
  const ok = { pending: 1, approved: 0, rejected: 0 };

  it("refuses counts that aren't a plain object of numbers", () => {
    expect(parseDraftList({ proposals: [], counts: [] })).toBeNull();
    expect(
      parseDraftList({ proposals: [], counts: { pending: 1 } })
    ).toBeNull();
    expect(
      parseDraftList({
        proposals: [],
        counts: { pending: -1, approved: 0, rejected: 0 },
      })
    ).toBeNull();
    expect(
      parseDraftList({
        proposals: [],
        counts: { pending: "1", approved: 0, rejected: 0 },
      })
    ).toBeNull();
    expect(parseDraftList({ proposals: [], counts: ok })).not.toBeNull();
  });

  it("refuses a by_project that isn't a plain object and skips bad entries", () => {
    expect(
      parseDraftList({ proposals: [], counts: ok, by_project: [] })
    ).toBeNull();
    expect(
      parseDraftList({ proposals: [], counts: ok, by_project: "x" })
    ).toBeNull();
    const parsed = parseDraftList({
      proposals: [],
      counts: ok,
      by_project: { "/a": ok, "/b": { pending: "x" }, "/c": [] },
    });
    expect(parsed?.byProject).toEqual({ "/a": ok });
  });
});

describe("projectLabels", () => {
  it("disambiguates folders that share a name", () => {
    const labels = projectLabels([
      project("/work/EvoSci_test"),
      project("/home/EvoSci_test"),
      project("/work/other"),
    ]);
    expect(labels.get("/work/EvoSci_test")).toBe("EvoSci_test (work)");
    expect(labels.get("/home/EvoSci_test")).toBe("EvoSci_test (home)");
    expect(labels.get("/work/other")).toBe("other");
  });

  it("uses the full key when the parents match too", () => {
    const labels = projectLabels([
      project("/a/work/x", "x"),
      project("/b/work/x", "x"),
    ]);
    expect(labels.get("/a/work/x")).toBe("/a/work/x");
    expect(labels.get("/b/work/x")).toBe("/b/work/x");
  });

  it("falls back to the key when a disambiguated label is still shared", () => {
    const labels = projectLabels([
      project("/work/A", "A"),
      project("/home/A", "A"),
      project("/x/y", "A (work)"),
    ]);
    expect(labels.get("/work/A")).toBe("/work/A");
    expect(labels.get("/x/y")).toBe("/x/y");
    expect(labels.get("/home/A")).toBe("A (home)");
  });

  it("labelFor falls back to the last path segment", () => {
    const labels = projectLabels([project("/w/A")]);
    expect(labelFor("/w/A", labels)).toBe("A");
    expect(labelFor("/w/unknown", labels)).toBe("unknown");
    expect(labelFor("C:\\w\\win", labels)).toBe("win");
  });
});

describe("groupDrafts", () => {
  const projects = [project("/work/B"), project("/work/A")];

  it("lists every project on Pending, newest first", () => {
    const groups = groupDrafts(
      list([
        draft({
          proposal_id: "1",
          skill_name: "old",
          created_at: "2026-11-01",
        }),
        draft({
          proposal_id: "2",
          skill_name: "new",
          created_at: "2026-11-03",
        }),
        draft({ proposal_id: "3", skill_name: "b", created_at: "2026-11-03" }),
      ]),
      projects,
      "pending"
    );
    expect(groups.map((g) => g.project.key)).toEqual(["/work/A", "/work/B"]);
    expect(groups[0].label).toBe("A");
    expect(groups[0].drafts.map((d) => d.skill_name)).toEqual([
      "b",
      "new",
      "old",
    ]);
    expect(groups[1].drafts).toEqual([]);
  });

  it("gives a draft of a project the list doesn't know yet its own group", () => {
    const groups = groupDrafts(
      list([draft({ workspace_dir: "/elsewhere/Z" })]),
      projects,
      "pending"
    );
    expect(groups.map((g) => g.label)).toEqual(["A", "B", "Z"]);
    expect(groups[2].project.key).toBe("/elsewhere/Z");
    expect(groups[2].drafts).toHaveLength(1);
  });

  it("orders drafts by the time they name, not the text", () => {
    const groups = groupDrafts(
      list([
        draft({
          proposal_id: "1",
          skill_name: "plus2",
          created_at: "2026-11-01T10:00:00+02:00",
        }),
        draft({
          proposal_id: "2",
          skill_name: "utc",
          created_at: "2026-11-01T09:00:00Z",
        }),
        draft({ proposal_id: "3", skill_name: "junk", created_at: "" }),
        draft({ proposal_id: "4", skill_name: "also", created_at: "nope" }),
      ]),
      projects,
      "pending"
    );
    expect(groups[0].drafts.map((d) => d.skill_name)).toEqual([
      "utc",
      "plus2",
      "also",
      "junk",
    ]);
  });

  it("gives an unknown project a Pending group only for a pending draft", () => {
    const groups = groupDrafts(
      list([
        draft({
          proposal_id: "1",
          status: "approved",
          workspace_dir: "/elsewhere/Z",
        }),
      ]),
      projects,
      "pending"
    );
    expect(groups.map((g) => g.label)).toEqual(["A", "B"]);
  });

  it("lists only projects with drafts on Approved and Rejected", () => {
    const l = list([
      draft({ proposal_id: "1", status: "approved", workspace_dir: "/work/B" }),
      draft({ proposal_id: "2", status: "pending", workspace_dir: "/work/A" }),
    ]);
    expect(
      groupDrafts(l, projects, "approved").map((g) => g.project.key)
    ).toEqual(["/work/B"]);
    expect(groupDrafts(l, projects, "rejected")).toEqual([]);
  });
});

describe("bannerSummary", () => {
  it("splits pending by project and finds the latest", () => {
    const projects = [project("/work/B"), project("/work/A")];
    const l = list(
      [
        draft({ proposal_id: "1", created_at: "2026-11-01T00:00:00Z" }),
        draft({ proposal_id: "2", created_at: "2026-11-03T00:00:00Z" }),
        draft({
          proposal_id: "3",
          status: "approved",
          created_at: "2026-11-09T00:00:00Z",
        }),
      ],
      {
        "/work/A": { pending: 2, approved: 0, rejected: 0 },
        "/work/B": { pending: 0, approved: 1, rejected: 0 },
      }
    );
    expect(bannerSummary(l, projects)).toEqual({
      pending: 2,
      split: [{ label: "A", count: 2 }],
      latest: "2026-11-03T00:00:00Z",
    });
    expect(bannerSummary(list([]), projects).latest).toBeNull();
  });

  it("compares times, not text, and names a project only byProject knows", () => {
    const l = list(
      [
        draft({ proposal_id: "1", created_at: "2026-11-01T10:00:00+02:00" }),
        draft({ proposal_id: "2", created_at: "2026-11-01T09:00:00Z" }),
        draft({ proposal_id: "3", created_at: "garbage" }),
      ],
      { "/other/Q": { pending: 3, approved: 0, rejected: 0 } }
    );
    expect(bannerSummary(l, [project("/work/A")])).toEqual({
      pending: 3,
      split: [{ label: "Q", count: 3 }],
      latest: "2026-11-01T09:00:00Z",
    });
    expect(
      bannerSummary(list([draft({ created_at: "garbage" })]), []).latest
    ).toBeNull();
  });
});

describe("installedLabel", () => {
  const labels = projectLabels([project("/work/A")]);

  it("names the project tier, the global tier and an uninstalled skill", () => {
    expect(installedLabel(draft({ status: "approved" }), labels)).toBe(
      "Installed into A/skills"
    );
    expect(
      installedLabel(draft({ status: "approved", scope: "global" }), labels)
    ).toBe("Installed into all projects (global)");
    expect(
      installedLabel(
        draft({ status: "approved", approved_skill_present: false }),
        labels
      )
    ).toBe("No longer installed");
    expect(installedLabel(draft({ status: "rejected" }), labels)).toBe(
      "Rejected. EvoMemory won't draft this pattern again."
    );
    expect(installedLabel(draft(), labels)).toBe("");
  });
});

describe("statusLine", () => {
  it("reads each cadence and mode, and off", () => {
    expect(AUTOSKILLS_FIELDS).toEqual([
      "memory_skill_synthesis_enabled",
      "memory_skill_synthesis_mode",
      "memory_skill_synthesis_cadence",
      "memory_skill_synthesis_time",
    ]);
    expect(statusLine(undefined)).toBeNull();
    expect(
      statusLine({
        memory_skill_synthesis_enabled: true,
        memory_skill_synthesis_mode: "review",
        memory_skill_synthesis_cadence: "weekly",
        memory_skill_synthesis_time: "03:00",
      })
    ).toBe("Every project · runs weekly at 03:00 · you review each draft");
    expect(
      statusLine({
        memory_skill_synthesis_enabled: true,
        memory_skill_synthesis_mode: "auto",
        memory_skill_synthesis_cadence: "nightly",
        memory_skill_synthesis_time: "02:30",
      })
    ).toBe(
      "Every project · runs every night at 02:30 · drafts install automatically"
    );
    expect(
      statusLine({
        memory_skill_synthesis_enabled: true,
        memory_skill_synthesis_mode: "review",
        memory_skill_synthesis_cadence: "monthly",
        memory_skill_synthesis_time: "04:00",
      })
    ).toBe("Every project · runs monthly at 04:00 · you review each draft");
    expect(statusLine({ memory_skill_synthesis_enabled: true })).toBe(
      "Every project · runs weekly at 03:00 · you review each draft"
    );
    expect(statusLine({ memory_skill_synthesis_enabled: false })).toBe(
      "AutoSkills is off in every project"
    );
  });
});

describe("fromMemorySkills", () => {
  it("maps installed approvals by tier and ignores other projects", () => {
    const l = list([
      draft({
        proposal_id: "1",
        status: "approved",
        scope: "global",
        approved_skill_path: "/home/u/.evoscientist/skills/g-skill",
        operation: "update",
      }),
      draft({
        proposal_id: "2",
        status: "approved",
        approved_skill_path: "C:\\w\\A\\skills\\p-skill",
      }),
      draft({
        proposal_id: "3",
        status: "approved",
        workspace_dir: "/work/B",
        approved_skill_path: "/work/B/skills/other",
      }),
      draft({
        proposal_id: "4",
        status: "approved",
        approved_skill_path: "/work/A/skills/gone",
        approved_skill_present: false,
      }),
      draft({ proposal_id: "5", approved_skill_path: "/work/A/skills/pend" }),
    ]);
    const out = fromMemorySkills(l, "/work/A");
    expect([...out.global]).toEqual([["g-skill", "update"]]);
    expect([...out.project]).toEqual([["p-skill", "create"]]);
    expect(fromMemorySkills(l, null).project.size).toBe(0);
  });
});

describe("isProjectCopy", () => {
  const global = "/home/u/.evoscientist/skills/data-cleaning";
  const project = "/work/A/skills/data-cleaning";
  const update = (over: Partial<Draft>) =>
    draft({ operation: "update", target_skill_name: "data-cleaning", ...over });

  it("is an update written to another folder than the one it starts from", () => {
    // A project's own copy of a global skill: the global one stays.
    expect(
      isProjectCopy(update({ install_target: project, install_base: global }))
    ).toBe(true);
    // In place.
    expect(
      isProjectCopy(update({ install_target: global, install_base: global }))
    ).toBe(false);
    expect(
      isProjectCopy(update({ install_target: project, install_base: project }))
    ).toBe(false);
  });

  it("counts an update the core can't place as a replace, and a new skill as neither", () => {
    // Decided, or the approval would fail: both null.
    expect(isProjectCopy(update({}))).toBe(false);
    expect(
      isProjectCopy(update({ install_target: project, install_base: null }))
    ).toBe(false);
    expect(
      isProjectCopy(update({ install_target: null, install_base: global }))
    ).toBe(false);
    expect(
      isProjectCopy(
        draft({
          operation: "create",
          install_target: project,
          install_base: global,
        })
      )
    ).toBe(false);
  });
});

describe("isRevertible", () => {
  it("allows rejects and new skills, not updates", () => {
    expect(isRevertible(draft({ operation: "update" }), "reject")).toBe(true);
    expect(isRevertible(draft({ operation: "create" }), "approve")).toBe(true);
    expect(isRevertible(draft({ operation: "update" }), "approve")).toBe(false);
  });
});

describe("autoSkillsReadOnlyReason", () => {
  it("names the reason", () => {
    expect(autoSkillsReadOnlyReason(undefined)).toBe(
      "Checking whether this page can review drafts…"
    );
    expect(autoSkillsReadOnlyReason({ writable: true })).toBeNull();
    expect(
      autoSkillsReadOnlyReason({ writable: false, reason: "not_loopback" })
    ).toBe(
      "This WebUI server listens on the network, not on this machine only, so it doesn't approve or reject drafts. Start it with EvoSci --ui webui, or with npm run dev:local."
    );
    expect(
      autoSkillsReadOnlyReason({ writable: false, reason: "host_not_loopback" })
    ).toBe(
      "This page is open by a network address. Drafts are reviewed from a page open at 127.0.0.1 or localhost on the machine that runs EvoScientist."
    );
    expect(
      autoSkillsReadOnlyReason({ writable: false, reason: "other_backend" })
    ).toBe(
      "The deployment URL is not the EvoScientist that runs next to this WebUI server, so drafts are reviewed on the machine that runs it."
    );
    expect(
      autoSkillsReadOnlyReason({ writable: false, reason: "unsupported" })
    ).toBe("This EvoScientist version cannot review drafts from the WebUI.");
    for (const reason of ["constructor", "toString", "made_up"]) {
      expect(
        autoSkillsReadOnlyReason({
          writable: false,
          reason,
        } as unknown as SettingsWriteAccess)
      ).toBe("This page can't review drafts right now.");
    }
    expect(
      autoSkillsReadOnlyReason({ writable: false, reason: "backend_timeout" })
    ).toBe("EvoScientist did not answer in time.");
  });
});
