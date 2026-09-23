// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";

import { ExpertsPanel } from "./ExpertsPanel";
import type { TeamEntry } from "@/lib/teams";

const teamsMock = vi.hoisted(() => ({
  value: {
    teams: [] as TeamEntry[],
    loading: false,
    error: null as string | null,
    refresh: vi.fn(),
  },
}));

vi.mock("@/app/hooks/useTeams", () => ({
  useTeams: () => teamsMock.value,
}));

vi.mock("./SkillDetailDialog", () => ({
  SkillDetailDialog: ({ skill }: { skill: { name: string } | null }) =>
    skill ? <div data-testid="detail">{skill.name}</div> : null,
}));

const catalogRow = (over: Record<string, unknown> = {}) => ({
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

function mockApi({
  catalog = [catalogRow()] as unknown[],
  skills = [] as unknown[],
  catalogFails = false,
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      const url = String(input);
      if (url.includes("/api/skills/catalog")) {
        return catalogFails
          ? Promise.resolve({
              ok: false,
              status: 502,
              json: () =>
                Promise.resolve({ error: "GitHub rate limit reached" }),
            })
          : Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ skills: catalog }),
            });
      }
      if (url.includes("/api/skills")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ skills }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    })
  );
}

beforeEach(() => {
  teamsMock.value = {
    teams: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ExpertsPanel", () => {
  it("lists catalog entries that ship an actor definition and hides plain skills", async () => {
    mockApi({
      catalog: [
        catalogRow(),
        catalogRow({
          name: "paper-writing",
          title: "Paper Writing",
          isExpert: false,
        }),
      ],
    });
    render(<ExpertsPanel />);

    expect(await screen.findByText("Paper Review")).toBeTruthy();
    expect(screen.queryByText("Paper Writing")).toBeNull();
  });

  it("offers Install for an expert that is not installed yet", async () => {
    mockApi({
      catalog: [catalogRow({ installed: false, installedVersion: undefined })],
    });
    render(<ExpertsPanel />);

    expect(
      await screen.findByRole("button", { name: /install/i })
    ).toBeTruthy();
    // Nothing to invite until it exists on disk.
    expect(screen.queryByRole("button", { name: /invite/i })).toBeNull();
  });

  it("lists an installed expert the catalog does not carry", async () => {
    teamsMock.value = {
      teams: [{ name: "my-lab-reviewer", description: "Local actor." }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    mockApi({
      catalog: [],
      skills: [
        {
          name: "my-lab-reviewer",
          title: "My Lab Reviewer",
          description: "Local actor.",
          dir: "/tmp/my-lab-reviewer",
          isExpert: true,
        },
      ],
    });
    render(<ExpertsPanel />);

    expect(await screen.findByText("My Lab Reviewer")).toBeTruthy();
  });

  it("keeps installed experts visible when the catalog cannot be reached", async () => {
    teamsMock.value = {
      teams: [
        { name: "paper-review", description: "Adversarial self-review." },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    mockApi({ catalogFails: true });
    render(<ExpertsPanel />);

    expect(await screen.findByText(/rate limit/i)).toBeTruthy();
    expect(screen.getByText("paper-review")).toBeTruthy();
  });

  it("explains where experts come from when there are none at all", async () => {
    mockApi({ catalog: [] });
    render(<ExpertsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/no experts/i)).toBeTruthy();
    });
  });

  it("offers no uninstall for an expert only the deployment can see", async () => {
    // Removal deletes from the global tier the browser scans; a builtin or
    // workspace-tier expert is not there, so the button could only 404.
    teamsMock.value = {
      teams: [
        { name: "builtin-expert", description: "Ships with the package." },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    mockApi({ catalog: [] });
    render(<ExpertsPanel />);

    expect(await screen.findByText("builtin-expert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /uninstall/i })).toBeNull();
    // It is still dispatchable — installed is all it takes.
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("keeps uninstall for a locally installed expert", async () => {
    teamsMock.value = {
      teams: [{ name: "my-lab-reviewer", description: "Local actor." }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    mockApi({
      catalog: [],
      skills: [
        {
          name: "my-lab-reviewer",
          title: "My Lab Reviewer",
          description: "Local actor.",
          dir: "/tmp/x",
          isExpert: true,
        },
      ],
    });
    render(<ExpertsPanel />);

    expect(
      await screen.findByRole("button", { name: /uninstall/i })
    ).toBeTruthy();
  });

  it("offers no uninstall for a catalog expert installed outside the global tier", async () => {
    // The deployment reports it, so it reads as installed; but the global-tier
    // scan cannot see it, so deleting it would 404.
    teamsMock.value = {
      teams: [
        { name: "paper-review", description: "Adversarial self-review." },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    mockApi({
      catalog: [catalogRow({ installed: false, installedVersion: undefined })],
    });
    render(<ExpertsPanel />);

    // Anchor on the catalog section itself: "other" can produce an Invite
    // before the catalog lands, so waiting on the button alone could assert
    // against the wrong branch.
    const section = (await screen.findByText(/official catalog/i))
      .parentElement!;
    const inSection = (name: RegExp) =>
      Array.from(section.querySelectorAll("button")).filter((b) =>
        name.test((b.textContent ?? "").trim())
      );
    expect(inSection(/^install$/i)).toHaveLength(0);
    expect(inSection(/uninstall/i)).toHaveLength(0);
    // Reads as installed, so it carries the Active marker.
    expect(section.textContent).toContain("Active");
  });

  it("asks before uninstalling instead of deleting on the first click", async () => {
    // The same skill is guarded by a confirm dialog in Research Skills; the
    // server side is an unguarded recursive delete, and a hand-written expert
    // may have no catalog copy to reinstall from.
    mockApi({});
    render(<ExpertsPanel />);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fireEvent.click(await screen.findByRole("button", { name: /uninstall/i }));

    const deleted = fetchMock.mock.calls.some(
      (call) => (call[1] as RequestInit | undefined)?.method === "DELETE"
    );
    expect(deleted).toBe(false);
    expect(screen.getByText(/uninstall expert\?/i)).toBeTruthy();
  });

  it("deletes only after the confirmation is accepted", async () => {
    mockApi({});
    render(<ExpertsPanel />);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fireEvent.click(await screen.findByRole("button", { name: /uninstall/i }));
    // The dialog's own confirm button, not the card's.
    const confirm = screen
      .getAllByRole("button", { name: /^uninstall$/i })
      .at(-1)!;
    fireEvent.click(confirm);

    await waitFor(() => {
      const deleted = fetchMock.mock.calls.some(
        (call) => (call[1] as RequestInit | undefined)?.method === "DELETE"
      );
      expect(deleted).toBe(true);
    });
  });

  it("keeps the expert when the confirmation is dismissed", async () => {
    mockApi({});
    render(<ExpertsPanel />);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fireEvent.click(await screen.findByRole("button", { name: /uninstall/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    const deleted = fetchMock.mock.calls.some(
      (call) => (call[1] as RequestInit | undefined)?.method === "DELETE"
    );
    expect(deleted).toBe(false);
  });

  it("refreshes the deployment's expert list too, not just the local one", async () => {
    // The list of installed experts is the deployment's answer; re-reading
    // only the catalog would leave a just-installed expert missing from it.
    const refresh = vi.fn();
    teamsMock.value = {
      teams: [],
      loading: false,
      error: null,
      refresh,
    };
    mockApi({ catalog: [] });
    render(<ExpertsPanel />);

    await screen.findByText(/no experts/i);
    refresh.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(refresh).toHaveBeenCalled();
  });

  it("ignores a stale reload that finishes after a newer one", async () => {
    // Reloads are kicked off by mutations, not by the Refresh button (which
    // is disabled while loading), so two can be in flight at once. The older
    // snapshot settling last would bring back an uninstalled expert.
    teamsMock.value = {
      teams: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    const both = [
      catalogRow(),
      catalogRow({ name: "going-away", title: "Going Away" }),
    ];

    let releaseStale!: () => void;
    let catalogCall = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "DELETE") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }
        if (url.includes("/api/skills/catalog")) {
          catalogCall += 1;
          if (catalogCall === 2) {
            // The reload from the first uninstall — hangs, answers last.
            return new Promise((resolve) => {
              releaseStale = () =>
                resolve({
                  ok: true,
                  json: () => Promise.resolve({ skills: both }),
                });
            });
          }
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ skills: catalogCall === 1 ? both : [] }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ skills: [] }),
        });
      })
    );

    render(<ExpertsPanel />);
    await screen.findByText("Going Away");

    const uninstallNth = async (n: number) => {
      fireEvent.click(screen.getAllByRole("button", { name: /uninstall/i })[n]);
      const buttons = screen.getAllByRole("button", { name: /^uninstall$/i });
      fireEvent.click(buttons[buttons.length - 1]);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    };

    await uninstallNth(1); // "Going Away" — its reload hangs
    await uninstallNth(0); // "Paper Review" — its reload answers immediately

    await waitFor(() => expect(screen.queryByText("Going Away")).toBeNull());

    await act(async () => {
      releaseStale();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText("Going Away")).toBeNull();
  });

  it("marks its cards with the experts glyph, not the skills one", async () => {
    // Research Skills keeps the puzzle piece; this view reads apart at a
    // glance even though both render the same tile component.
    mockApi({});
    render(<ExpertsPanel />);

    await screen.findByText("Paper Review");
    expect(document.querySelector("svg.lucide-users")).toBeTruthy();
    expect(document.querySelector("svg.lucide-puzzle")).toBeNull();
  });
});
