// @vitest-environment jsdom
//
// Research Skills keeps listing every skill, experts included — an expert IS a
// skill and stays usable as one. The only thing that changes here is a marker
// pointing at its second identity.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import type { Draft } from "@/lib/autoskills";
import { projectHandle } from "@/lib/projects";
import type { ProjectsContextValue } from "@/providers/ProjectsProvider";
import {
  TEST_PROJECT,
  TestProjectsProvider,
  mockProjects,
  readyProjects,
} from "@/test/mockProjects";

const nav = vi.hoisted(() => ({ setView: vi.fn() }));

vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    useQueryState: (key: string) =>
      key === "view"
        ? [null, nav.setView]
        : react.useState<string | null>(null),
  };
});

vi.mock("./SkillDetailDialog", () => ({
  SkillDetailDialog: () => null,
}));

// The drafts: none known unless a test says so (the banner then shows
// nothing, and no skill carries a memory tag).
const hooks = vi.hoisted(() => ({
  auto: { status: "loading" } as Record<string, unknown>,
  refresh: vi.fn(async () => undefined),
}));
vi.mock("@/app/hooks/useAutoSkills", () => ({
  useAutoSkills: () => ({ ...hooks.auto, refresh: vi.fn() }),
  readAutoSeenAt: () => null,
  refreshAutoSkills: hooks.refresh,
}));
vi.mock("@/providers/ClientProvider", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDeployment: () => ({ deploymentUrl: "http://127.0.0.1:6174", apiKey: "" }),
}));

import { SkillsMarketplace } from "./SkillsMarketplace";

/** Research Skills with the current project's files on this machine, unless
 *  `projects` says otherwise. */
function renderPage(projects: ProjectsContextValue = mockProjects()) {
  return render(
    <TestProjectsProvider value={projects}>
      <SkillsMarketplace />
    </TestProjectsProvider>
  );
}

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "paper-review",
  title: "Paper Review",
  description: "Adversarial self-review.",
  fileCount: 12,
  installed: true,
  isExpert: true,
  latestVersion: "1.2.0",
  installedVersion: "1.2.0",
  updateAvailable: false,
  ...over,
});

/** The catalog, the global tiers' skills and, for a request that names a
 *  project, that project's skills. */
function mockApi(
  catalog: unknown[],
  skills: unknown[] = [],
  projectSkills: unknown[] | null = null
) {
  const fetchMock = vi.fn((input: string, _init?: RequestInit) => {
    const url = String(input);
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve(
          url.includes("catalog")
            ? { skills: catalog }
            : {
                skills,
                projectSkills: url.includes("project=") ? projectSkills : null,
              }
        ),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  nav.setView.mockClear();
  hooks.auto = { status: "loading" };
  hooks.refresh.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("SkillsMarketplace expert marker", () => {
  it("still lists a skill that is also an expert", async () => {
    mockApi([row()]);
    renderPage();
    expect(await screen.findByText("Paper Review")).toBeTruthy();
  });

  it("marks it as an expert", async () => {
    mockApi([row()]);
    renderPage();
    expect(await screen.findByRole("button", { name: /expert/i })).toBeTruthy();
  });

  // The same brand pill as the composer's: globals.css takes button borders
  // away, so the outline needs border-solid.
  it("draws the marker as a pill: a brand outline on the soft brand fill", async () => {
    mockApi([row()]);
    renderPage();
    const marker = await screen.findByRole("button", { name: /expert/i });
    const classes = marker.className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        "rounded-full",
        "border",
        "border-solid",
        "border-[var(--brand)]",
        "bg-[var(--brand-soft)]",
      ])
    );
    // Hover darkens the brand colour (lightens it in dark mode): fading the
    // whole pill took its text under 4.5:1.
    expect(classes).not.toContain("hover:opacity-80");
    expect(classes).toEqual(
      expect.arrayContaining([
        "enabled:hover:border-[var(--brand-hover)]",
        "enabled:hover:text-[var(--brand-hover)]",
      ])
    );
  });

  it("leaves an ordinary skill unmarked", async () => {
    mockApi([row({ isExpert: false })]);
    renderPage();
    await screen.findByText("Paper Review");
    expect(screen.queryByRole("button", { name: /expert/i })).toBeNull();
  });

  it("jumps to the Experts view from the marker", async () => {
    mockApi([row()]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /expert/i }));
    expect(nav.setView).toHaveBeenCalledWith("experts");
  });

  it("hides an expert that declares itself expert-only", async () => {
    // `metadata.type: [expert]` — a dispatchable actor with no standalone
    // value as a skill. It stays manageable under Experts.
    //
    // Anchor on a sibling that must render: asserting absence before the
    // catalog lands would pass for the wrong reason.
    mockApi([
      row({ isExpert: true, isSkill: false }),
      row({ name: "paper-writing", title: "Paper Writing", isExpert: false }),
    ]);
    renderPage();
    expect(await screen.findByText("Paper Writing")).toBeTruthy();
    expect(screen.queryByText("Paper Review")).toBeNull();
  });

  it("keeps an expert that also declares itself a skill", async () => {
    mockApi([row({ isExpert: true, isSkill: true })]);
    renderPage();
    expect(await screen.findByText("Paper Review")).toBeTruthy();
  });

  it("keeps a skill that never declared a type", async () => {
    // The common case by far — absence must not remove anything.
    const { isSkill: _omit, ...noDeclaration } = row({ isExpert: true });
    mockApi([noDeclaration]);
    renderPage();
    expect(await screen.findByText("Paper Review")).toBeTruthy();
  });

  it("tells expert consumers to refresh after installing", async () => {
    // paper-review lives in this catalog, so an expert can be installed from
    // here — and the Experts view and composer pill must not keep counting a
    // stale list afterwards.
    mockApi([row({ installed: false })]);
    const onChange = vi.fn();
    window.addEventListener("evo-teams-change", onChange);

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^install$/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    window.removeEventListener("evo-teams-change", onChange);
  });

  it("tells them again after uninstalling", async () => {
    mockApi([row({ installed: true })]);
    const onChange = vi.fn();
    window.addEventListener("evo-teams-change", onChange);

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /^uninstall$/i })
    );
    // Removal is behind a confirmation dialog.
    const buttons = screen.getAllByRole("button", { name: /^uninstall$/i });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    window.removeEventListener("evo-teams-change", onChange);
  });
});

// An installed skill as GET /api/skills lists it.
const card = (name: string, title = name) => ({
  name,
  title,
  description: `${title} does a thing.`,
  dir: `/x/${name}`,
  isExpert: false,
  isSkill: true,
});

function approved(over: Partial<Draft> & { proposal_id: string }): Draft {
  return {
    skill_name: over.proposal_id,
    description: "",
    operation: "create",
    target_skill_name: null,
    scope: "workspace",
    submitted_scope: null,
    status: "approved",
    workspace_dir: TEST_PROJECT,
    created_at: "2026-11-01T09:00:00Z",
    updated_at: "2026-11-01T09:00:00Z",
    approved_at: "2026-11-02T09:00:00Z",
    approved_by: "user",
    rejected_at: null,
    approved_skill_path: null,
    approved_skill_present: true,
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

function readyDrafts(drafts: Draft[]) {
  hooks.auto = {
    status: "ready",
    list: {
      drafts,
      counts: { pending: 0, approved: drafts.length, rejected: 0 },
      byProject: {},
    },
  };
}

/** A section's element, by its heading. */
const section = (name: string) =>
  screen.getByRole("heading", { name }).closest("section") as HTMLElement;
/** The row holding a tile's title, where its tag sits. */
const titleRow = (title: string) =>
  screen.getByRole("heading", { name: title }).parentElement as HTMLElement;

describe("SkillsMarketplace skills from memory", () => {
  it("shows This project's skills with from-memory tags", async () => {
    const fetchMock = mockApi(
      [],
      [card("global-skill")],
      [
        card("arxiv-paper-retrieval", "Arxiv Paper Retrieval"),
        card("lit-review", "Lit Review"),
        card("hand-made", "Hand Made"),
      ]
    );
    readyDrafts([
      approved({
        proposal_id: "p1",
        approved_skill_path: `${TEST_PROJECT}/skills/arxiv-paper-retrieval`,
      }),
      approved({
        proposal_id: "p2",
        operation: "update",
        approved_skill_path: `${TEST_PROJECT}/skills/lit-review`,
      }),
      // Another project's skill of the same name isn't this one.
      approved({
        proposal_id: "p3",
        workspace_dir: "/srv/projB",
        approved_skill_path: "/srv/projB/skills/hand-made",
      }),
    ]);
    renderPage();

    await screen.findByRole("heading", { name: "This project's skills" });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/skills?project=${projectHandle(TEST_PROJECT)}`
    );
    const mine = section("This project's skills");
    expect(
      within(mine)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent)
    ).toEqual([
      "This project's skills",
      "Arxiv Paper Retrieval",
      "Lit Review",
      "Hand Made",
    ]);
    expect(
      within(titleRow("Arxiv Paper Retrieval")).getByText("from memory")
    ).toBeTruthy();
    expect(
      within(titleRow("Lit Review")).getByText("updated from memory")
    ).toBeTruthy();
    expect(within(titleRow("Hand Made")).queryByText(/memory/)).toBeNull();
    expect(
      within(mine).getAllByRole("button", { name: "Uninstall" })
    ).toHaveLength(3);

    // Above the global tier's other skills.
    const other = section("Other installed skills");
    expect(
      mine.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(within(other).getByText("global-skill")).toBeTruthy();
  });

  it("uninstalls a project skill from its project only, after the confirm", async () => {
    const fetchMock = mockApi(
      [],
      [card("arxiv-paper-retrieval")],
      [card("arxiv-paper-retrieval", "Arxiv Paper Retrieval")]
    );
    const onTeams = vi.fn();
    window.addEventListener("evo-teams-change", onTeams);
    renderPage();

    await screen.findByRole("heading", { name: "This project's skills" });
    fireEvent.click(
      within(section("This project's skills")).getByRole("button", {
        name: "Uninstall",
      })
    );
    // The page's own question first, saying what goes: the folder, for good.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Uninstall skill?")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "This deletes the folder projA/skills/arxiv-paper-retrieval. It can't be undone."
      )
    ).toBeTruthy();
    expect(within(dialog).queryByText(/install it again/)).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Uninstall" })
    ).toBeNull();
    const reads = fetchMock.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onTeams).toHaveBeenCalled());
    window.removeEventListener("evo-teams-change", onTeams);
    const deletes = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "DELETE"
    );
    expect(deletes.map(([url]) => url)).toEqual([
      `/api/skills?project=${projectHandle(
        TEST_PROJECT
      )}&name=arxiv-paper-retrieval`,
    ]);
    // The lists and the drafts are read again.
    expect(hooks.refresh).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls
          .slice(reads)
          .some(
            ([url, init]) =>
              init?.method !== "DELETE" &&
              url === `/api/skills?project=${projectHandle(TEST_PROJECT)}`
          )
      ).toBe(true)
    );
  });

  it("tags global skills from memory", async () => {
    mockApi(
      [],
      [card("global-skill"), card("global-update"), card("plain")],
      []
    );
    readyDrafts([
      approved({
        proposal_id: "g1",
        scope: "global",
        approved_skill_path: "/home/you/.evoscientist/skills/global-skill",
      }),
      approved({
        proposal_id: "g2",
        scope: "global",
        operation: "update",
        approved_skill_path: "/home/you/.evoscientist/skills/global-update",
      }),
    ]);
    const view = renderPage();

    await screen.findByRole("heading", { name: "Other installed skills" });
    // An empty project folder adds no section.
    expect(
      screen.queryByRole("heading", { name: "This project's skills" })
    ).toBeNull();
    expect(
      within(titleRow("global-skill")).getByText("from memory")
    ).toBeTruthy();
    expect(
      within(titleRow("global-update")).getByText("updated from memory")
    ).toBeTruthy();
    expect(within(titleRow("plain")).queryByText(/memory/)).toBeNull();

    // Only while the drafts are known.
    hooks.auto = { status: "error", error: new Error("HTTP 500") };
    view.rerender(
      <TestProjectsProvider value={mockProjects()}>
        <SkillsMarketplace />
      </TestProjectsProvider>
    );
    expect(screen.getByText("global-skill")).toBeTruthy();
    expect(screen.queryByText("from memory")).toBeNull();
  });

  it("tags catalog skills a global draft updated", async () => {
    mockApi(
      [
        row({ isExpert: false }),
        row({ name: "paper-writing", title: "Paper Writing", isExpert: false }),
      ],
      [card("paper-review"), card("paper-writing")],
      []
    );
    readyDrafts([
      approved({
        proposal_id: "u1",
        scope: "global",
        operation: "update",
        target_skill_name: "paper-review",
        approved_skill_path: "/home/you/.evoscientist/skills/paper-review",
      }),
    ]);
    renderPage();
    await screen.findByText("Paper Review");
    expect(
      within(titleRow("Paper Review")).getByText("updated from memory")
    ).toBeTruthy();
    expect(within(titleRow("Paper Writing")).queryByText(/memory/)).toBeNull();
  });

  it("hides This project's skills when files are elsewhere", async () => {
    // Even an answer that carried some isn't shown for a project whose
    // folder this page can't read.
    const fetchMock = vi.fn((input: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            String(input).includes("catalog")
              ? { skills: [] }
              : { skills: [card("plain")], projectSkills: [card("theirs")] }
          ),
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPage(
      mockProjects(readyProjects(TEST_PROJECT), { files: "elsewhere" })
    );

    await screen.findByRole("heading", { name: "Other installed skills" });
    expect(fetchMock).toHaveBeenCalledWith("/api/skills");
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("project="))
    ).toBe(false);
    expect(
      screen.queryByRole("heading", { name: "This project's skills" })
    ).toBeNull();
    expect(screen.queryByText("theirs")).toBeNull();
  });

  it("reads the new project's skills when the project changes during an uninstall", async () => {
    const B = "/srv/projB";
    let finishDelete: (() => void) | undefined;
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") {
        return new Promise((resolve) => {
          finishDelete = () =>
            resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
        });
      }
      const mine = url.includes(`project=${projectHandle(B)}`)
        ? [card("b-skill")]
        : [card("a-skill")];
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes("catalog")
              ? { skills: [] }
              : { skills: [], projectSkills: mine }
          ),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = (current: string) => (
      <TestProjectsProvider
        value={mockProjects(readyProjects(TEST_PROJECT, B), { current })}
      >
        <SkillsMarketplace />
      </TestProjectsProvider>
    );
    const view = render(page(TEST_PROJECT));

    await screen.findByText("a-skill");
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(finishDelete).toBeDefined());

    // Another project becomes current before the removal answers.
    view.rerender(page(B));
    await screen.findByText("b-skill");
    finishDelete?.();

    await waitFor(() => expect(hooks.refresh).toHaveBeenCalled());
    // The read after the removal is the current project's, so its skills stay.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            init?.method !== "DELETE" &&
            url === `/api/skills?project=${projectHandle(B)}`
        ).length
      ).toBeGreaterThan(1)
    );
    expect(screen.getByText("b-skill")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "This project's skills" })
    ).toBeTruthy();
  });

  it("a same-named skill of the next project doesn't spin while the last one's is deleted", async () => {
    const B = "/srv/projB";
    let finishDelete: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          return new Promise((resolve) => {
            finishDelete = () =>
              resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              String(input).includes("catalog")
                ? { skills: [] }
                : { skills: [], projectSkills: [card("shared-name")] }
            ),
        });
      })
    );
    const page = (current: string) => (
      <TestProjectsProvider
        value={mockProjects(readyProjects(TEST_PROJECT, B), { current })}
      >
        <SkillsMarketplace />
      </TestProjectsProvider>
    );
    const view = render(page(TEST_PROJECT));

    await screen.findByText("shared-name");
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("button", { name: "Removing…" });

    view.rerender(page(B));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Uninstall" })).toBeTruthy()
    );
    expect(screen.queryByRole("button", { name: "Removing…" })).toBeNull();
    finishDelete?.();
    await waitFor(() => expect(hooks.refresh).toHaveBeenCalled());
  });
});

// The page never waits for the project check: the catalog and the global
// lists are read at once, and "This project's skills" follows on its own
// read once the project is known here (and again on a project switch).
describe("SkillsMarketplace reads", () => {
  const page = (value: ProjectsContextValue) => (
    <TestProjectsProvider value={value}>
      <SkillsMarketplace />
    </TestProjectsProvider>
  );
  const skillReads = (fetchMock: ReturnType<typeof mockApi>) =>
    fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter(
        (url) => url.startsWith("/api/skills") && !url.includes("catalog")
      );
  const catalogReads = (fetchMock: ReturnType<typeof mockApi>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes("catalog"));

  it("shows the global lists while the project check never answers", async () => {
    // The projects are known, but whether this page reads their files never
    // is (the check failed and gave up).
    const fetchMock = mockApi([row({ installed: false })], [card("plain")]);
    render(
      page(mockProjects(readyProjects(TEST_PROJECT), { files: "pending" }))
    );

    expect(await screen.findByText("Paper Review")).toBeTruthy();
    expect(await screen.findByText("plain")).toBeTruthy();
    expect(skillReads(fetchMock)).toEqual(["/api/skills"]);
    expect(
      screen.queryByRole("heading", { name: "This project's skills" })
    ).toBeNull();
  });

  it("adds the project's skills once the project is known, loading the page once", async () => {
    const fetchMock = mockApi(
      [row({ installed: false })],
      [card("plain")],
      [card("mine")]
    );
    // Nothing known yet: the global lists come at once.
    const view = render(
      page(mockProjects({ status: "pending" }, { files: "pending" }))
    );
    expect(screen.getByText("Loading skills…")).toBeTruthy();
    expect(await screen.findByText("plain")).toBeTruthy();
    expect(screen.getByText("Paper Review")).toBeTruthy();

    // Then the projects, then the files are here: only the section is read.
    view.rerender(
      page(mockProjects(readyProjects(TEST_PROJECT), { files: "pending" }))
    );
    view.rerender(
      page(mockProjects(readyProjects(TEST_PROJECT), { files: "here" }))
    );
    expect(screen.queryByText("Loading skills…")).toBeNull();
    await screen.findByRole("heading", { name: "This project's skills" });
    expect(screen.getByText("mine")).toBeTruthy();
    expect(screen.getByText("plain")).toBeTruthy();
    expect(screen.queryByText("Loading skills…")).toBeNull();
    expect(skillReads(fetchMock)).toEqual([
      "/api/skills",
      `/api/skills?project=${projectHandle(TEST_PROJECT)}`,
    ]);
    expect(catalogReads(fetchMock)).toHaveLength(1);
  });

  it("reads the page and the project's skills apart when the project is known at once", async () => {
    const fetchMock = mockApi([], [card("plain")], [card("mine")]);
    render(page(mockProjects()));
    await screen.findByRole("heading", { name: "This project's skills" });
    expect(screen.getByText("plain")).toBeTruthy();
    // Never one read for both: neither waits for, nor overwrites, the other.
    expect(skillReads(fetchMock)).toEqual([
      "/api/skills",
      `/api/skills?project=${projectHandle(TEST_PROJECT)}`,
    ]);
    expect(catalogReads(fetchMock)).toHaveLength(1);
  });

  it("a switch during the first read: the global lists and the new project's skills stand, the old read's failure touches neither", async () => {
    const B = "/srv/projB";
    let failA: (() => void) | undefined;
    const fetchMock = vi.fn((input: string, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`project=${projectHandle(TEST_PROJECT)}`)) {
        return new Promise((resolve) => {
          failA = () =>
            resolve({
              ok: false,
              json: () => Promise.resolve({ error: "A's read failed" }),
            });
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes("catalog")
              ? { skills: [row({ installed: false })] }
              : url.includes("project=")
              ? { skills: [card("plain")], projectSkills: [card("b-skill")] }
              : { skills: [card("plain")], projectSkills: null }
          ),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const at = (current: string) =>
      page(mockProjects(readyProjects(TEST_PROJECT, B), { current }));
    const view = render(at(TEST_PROJECT));
    view.rerender(at(B));

    // The global lists don't wait for A's read.
    expect(await screen.findByText("plain")).toBeTruthy();
    expect(await screen.findByText("b-skill")).toBeTruthy();
    expect(screen.getByText("Paper Review")).toBeTruthy();
    expect(screen.queryByText("Loading skills…")).toBeNull();

    failA?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("plain")).toBeTruthy();
    expect(screen.getByText("b-skill")).toBeTruthy();
    expect(screen.queryByText("A's read failed")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Loading skills…")).toBeNull();
  });

  it("a failed read of the project's skills is said in that section, until its next read", async () => {
    const B = "/srv/projB";
    const fetchMock = vi.fn((input: string, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`project=${projectHandle(TEST_PROJECT)}`)) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: "projA isn't served" }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes("catalog")
              ? { skills: [] }
              : url.includes("project=")
              ? { skills: [card("plain")], projectSkills: [card("b-skill")] }
              : { skills: [card("plain")], projectSkills: null }
          ),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const at = (current: string) =>
      page(mockProjects(readyProjects(TEST_PROJECT, B), { current }));
    const view = render(at(TEST_PROJECT));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("projA isn't served");
    expect(section("This project's skills").contains(alert)).toBe(true);
    // The global lists are the page's, and stand.
    expect(screen.getByText("plain")).toBeTruthy();

    view.rerender(at(B));
    expect(await screen.findByText("b-skill")).toBeTruthy();
    expect(screen.queryByText("projA isn't served")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a project switch reads only the new project's section", async () => {
    const B = "/srv/projB";
    const fetchMock = vi.fn((input: string, _init?: RequestInit) => {
      const url = String(input);
      const own = url.includes(`project=${projectHandle(B)}`)
        ? [card("b-skill")]
        : [card("a-skill")];
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes("catalog")
              ? { skills: [row({ installed: false })] }
              : {
                  skills: [card("plain")],
                  projectSkills: url.includes("project=") ? own : null,
                }
          ),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const at = (current: string) =>
      page(mockProjects(readyProjects(TEST_PROJECT, B), { current }));
    const view = render(at(TEST_PROJECT));
    await screen.findByText("a-skill");
    const before = fetchMock.mock.calls.length;

    view.rerender(at(B));
    // The page stays as it is: no loading, the global lists still shown.
    expect(screen.queryByText("Loading skills…")).toBeNull();
    expect(screen.getByText("plain")).toBeTruthy();
    expect(screen.getByText("Paper Review")).toBeTruthy();
    await screen.findByText("b-skill");
    expect(screen.queryByText("a-skill")).toBeNull();
    expect(
      fetchMock.mock.calls.slice(before).map(([url]) => String(url))
    ).toEqual([`/api/skills?project=${projectHandle(B)}`]);
  });

  it("reads the global lists once when there is no project to ask about", async () => {
    // A core without projects, a backend with none, or a project list that
    // can't be read: one read of the global lists, no project read.
    for (const value of [
      mockProjects({ status: "unsupported" }, { files: "pending" }),
      mockProjects(readyProjects(), { files: "pending" }),
      {
        ...mockProjects({ status: "pending" }, { files: "pending" }),
        error: "Failed to fetch",
      },
    ]) {
      const fetchMock = mockApi([], [card("plain")]);
      const view = render(page(value));
      await screen.findByRole("heading", { name: "Other installed skills" });
      expect(skillReads(fetchMock)).toEqual(["/api/skills"]);
      view.unmount();
      vi.unstubAllGlobals();
    }
  });
});

describe("SkillsMarketplace global uninstall", () => {
  it("keeps the global confirm and reads the drafts again", async () => {
    mockApi([row({ installed: true })]);
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /^uninstall$/i })
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/will be removed from this Web UI/)
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    // A from-memory global skill's draft says it's gone at once.
    await waitFor(() => expect(hooks.refresh).toHaveBeenCalled());
  });
});
