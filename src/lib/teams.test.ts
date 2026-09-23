import { describe, it, expect } from "vitest";

import { parseTeams, buildExpertSections } from "./teams";

describe("parseTeams", () => {
  it("reads the name and description of each entry", () => {
    expect(
      parseTeams({
        teams: [
          { name: "paper-review", description: "Adversarial self-review." },
        ],
      })
    ).toEqual([
      { name: "paper-review", description: "Adversarial self-review." },
    ]);
  });

  it("returns nothing when the payload is not shaped like a team list", () => {
    expect(parseTeams(null)).toEqual([]);
    expect(parseTeams({})).toEqual([]);
    expect(parseTeams({ teams: "paper-review" })).toEqual([]);
  });

  it("drops entries without a usable name", () => {
    expect(
      parseTeams({
        teams: [{ description: "no name" }, { name: "", description: "empty" }],
      })
    ).toEqual([]);
  });

  it("defaults a missing description to an empty string", () => {
    // The backend always sends one, but it falls back to placeholder text when
    // the skill's frontmatter is unreadable — never trust it to be a string.
    expect(parseTeams({ teams: [{ name: "paper-review" }] })).toEqual([
      { name: "paper-review", description: "" },
    ]);
  });
});

describe("buildExpertSections", () => {
  const catalogExpert = {
    name: "paper-review",
    title: "Paper Review",
    description: "Adversarial self-review.",
    fileCount: 12,
    installed: true,
    isExpert: true,
    latestVersion: "1.2.0",
    installedVersion: "1.2.0",
    updateAvailable: false,
  };
  const catalogSkill = {
    name: "paper-writing",
    title: "Paper Writing",
    description: "Drafting workflow.",
    fileCount: 9,
    installed: true,
    isExpert: false,
    updateAvailable: false,
  };

  it("keeps only the catalog entries that ship an actor definition", () => {
    const { catalog } = buildExpertSections({
      teams: [],
      catalog: [catalogExpert, catalogSkill],
      installed: [],
    });
    expect(catalog.map((c) => c.name)).toEqual(["paper-review"]);
  });

  it("lists an installed expert that the catalog does not carry", () => {
    const { other } = buildExpertSections({
      teams: [{ name: "my-lab-reviewer", description: "Local actor." }],
      catalog: [catalogExpert],
      installed: [
        {
          name: "my-lab-reviewer",
          title: "My Lab Reviewer",
          description: "Local actor.",
          isExpert: true,
        },
      ],
    });
    expect(other).toEqual([
      {
        name: "my-lab-reviewer",
        title: "My Lab Reviewer",
        description: "Local actor.",
        removable: true,
      },
    ]);
  });

  it("still lists an expert the deployment reports but the browser cannot see", () => {
    // `/api/teams` walks workspace + global + builtin; the Next.js route only
    // reads the global install dir, so a builtin or workspace expert has no
    // local row to merge with. It degrades to name + description, not absent.
    const { other } = buildExpertSections({
      teams: [
        { name: "builtin-expert", description: "Ships with the pip package." },
      ],
      catalog: [],
      installed: [],
    });
    expect(other).toEqual([
      {
        name: "builtin-expert",
        title: "builtin-expert",
        description: "Ships with the pip package.",
        removable: false,
      },
    ]);
  });

  it("does not repeat a catalog expert in the other section", () => {
    const { other } = buildExpertSections({
      teams: [
        { name: "paper-review", description: "Adversarial self-review." },
      ],
      catalog: [catalogExpert],
      installed: [],
    });
    expect(other).toEqual([]);
  });
});

describe("buildExpertSections installed state", () => {
  const notInstalledLocally = {
    name: "paper-review",
    title: "Paper Review",
    description: "Adversarial self-review.",
    installed: false,
    isExpert: true,
    latestVersion: "1.2.0",
    updateAvailable: false,
  };

  it("trusts the deployment over the local scan for installed state", () => {
    // A workspace-tier expert lives under the run's own `skills/` dir, which
    // the Next.js route never reads — the catalog would offer "Install" for
    // something already installed, and installing would shadow it globally.
    const { catalog } = buildExpertSections({
      teams: [
        { name: "paper-review", description: "Adversarial self-review." },
      ],
      catalog: [notInstalledLocally],
      installed: [],
    });
    expect(catalog[0].installed).toBe(true);
  });

  it("leaves an expert the deployment does not report as not installed", () => {
    const { catalog } = buildExpertSections({
      teams: [],
      catalog: [notInstalledLocally],
      installed: [],
    });
    expect(catalog[0].installed).toBe(false);
  });

  it("sorts the other section by title", () => {
    const { other } = buildExpertSections({
      teams: [
        { name: "zeta-expert", description: "z" },
        { name: "alpha-expert", description: "a" },
      ],
      catalog: [],
      installed: [],
    });
    expect(other.map((e) => e.name)).toEqual(["alpha-expert", "zeta-expert"]);
  });
});

describe("buildExpertSections removability", () => {
  it("marks an expert the browser can see as removable", () => {
    const { other } = buildExpertSections({
      teams: [{ name: "my-lab-reviewer", description: "Local actor." }],
      catalog: [],
      installed: [
        {
          name: "my-lab-reviewer",
          title: "My Lab Reviewer",
          description: "Local actor.",
          isExpert: true,
        },
      ],
    });
    expect(other[0].removable).toBe(true);
  });

  it("marks an expert only the deployment can see as not removable", () => {
    // Uninstall deletes from the global tier the Next.js route scans. A
    // builtin or workspace-tier expert is not there, so offering the button
    // would advertise an action that can only 404.
    const { other } = buildExpertSections({
      teams: [
        { name: "builtin-expert", description: "Ships with the package." },
      ],
      catalog: [],
      installed: [],
    });
    expect(other[0].removable).toBe(false);
  });
});

describe("buildExpertSections catalog removability", () => {
  const base = {
    name: "paper-review",
    title: "Paper Review",
    description: "Adversarial self-review.",
    isExpert: true,
    updateAvailable: false,
  };

  it("marks a catalog expert the browser can see as removable", () => {
    const { catalog } = buildExpertSections({
      teams: [{ name: "paper-review", description: "" }],
      catalog: [{ ...base, installed: true }],
      installed: [],
    });
    expect(catalog[0].removable).toBe(true);
  });

  it("marks a catalog expert only the deployment can see as not removable", () => {
    // Installed in the workspace tier: `/api/teams` sees it, the global-tier
    // scan does not, so `installed` gets promoted for display — but removal
    // still targets the global tier and would 404.
    const { catalog } = buildExpertSections({
      teams: [{ name: "paper-review", description: "" }],
      catalog: [{ ...base, installed: false }],
      installed: [],
    });
    expect(catalog[0].installed).toBe(true);
    expect(catalog[0].removable).toBe(false);
  });
});

// Three independent facts get conflated easily, so pin them apart:
//   is it an expert   -> does it belong in this view at all
//   is it installed   -> Install vs Uninstall
//   can it be invited -> does the DEPLOYMENT know the name (it dispatches)
describe("buildExpertSections across inconsistent snapshots", () => {
  const row = {
    name: "paper-review",
    title: "Paper Review",
    description: "Adversarial self-review.",
    isExpert: true,
    updateAvailable: false,
  };

  it("trusts the local scan when the catalog snapshot predates an install", () => {
    // Both answers describe the same directories, but they are two separate
    // requests: the catalog's copy can be a moment older. Offering Install
    // for something the other answer already lists would be wrong.
    const { catalog } = buildExpertSections({
      teams: [],
      catalog: [{ ...row, installed: false }],
      installed: [
        {
          name: "paper-review",
          title: "Paper Review",
          description: "",
          isExpert: true,
        },
      ],
    });
    expect(catalog[0].installed).toBe(true);
    expect(catalog[0].removable).toBe(true);
  });

  it("keeps a deployment-only expert unremovable", () => {
    // Promoted to installed by the deployment, but absent from the tier the
    // browser deletes from — so removal must stay off.
    const { catalog } = buildExpertSections({
      teams: [{ name: "paper-review", description: "" }],
      catalog: [{ ...row, installed: false }],
      installed: [],
    });
    expect(catalog[0].installed).toBe(true);
    expect(catalog[0].removable).toBe(false);
  });
});
