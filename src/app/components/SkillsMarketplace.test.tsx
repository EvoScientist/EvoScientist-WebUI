// @vitest-environment jsdom
//
// Research Skills keeps listing every skill, experts included — an expert IS a
// skill and stays usable as one. The only thing that changes here is a marker
// pointing at its second identity.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

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

import { SkillsMarketplace } from "./SkillsMarketplace";

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

function mockApi(catalog: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            skills: String(input).includes("catalog") ? catalog : [],
          }),
      })
    )
  );
}

beforeEach(() => nav.setView.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe("SkillsMarketplace expert marker", () => {
  it("still lists a skill that is also an expert", async () => {
    mockApi([row()]);
    render(<SkillsMarketplace />);
    expect(await screen.findByText("Paper Review")).toBeTruthy();
  });

  it("marks it as an expert", async () => {
    mockApi([row()]);
    render(<SkillsMarketplace />);
    expect(await screen.findByRole("button", { name: /expert/i })).toBeTruthy();
  });

  it("leaves an ordinary skill unmarked", async () => {
    mockApi([row({ isExpert: false })]);
    render(<SkillsMarketplace />);
    await screen.findByText("Paper Review");
    expect(screen.queryByRole("button", { name: /expert/i })).toBeNull();
  });

  it("jumps to the Experts view from the marker", async () => {
    mockApi([row()]);
    render(<SkillsMarketplace />);
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
    render(<SkillsMarketplace />);
    expect(await screen.findByText("Paper Writing")).toBeTruthy();
    expect(screen.queryByText("Paper Review")).toBeNull();
  });

  it("keeps an expert that also declares itself a skill", async () => {
    mockApi([row({ isExpert: true, isSkill: true })]);
    render(<SkillsMarketplace />);
    expect(await screen.findByText("Paper Review")).toBeTruthy();
  });

  it("keeps a skill that never declared a type", async () => {
    // The common case by far — absence must not remove anything.
    const { isSkill: _omit, ...noDeclaration } = row({ isExpert: true });
    mockApi([noDeclaration]);
    render(<SkillsMarketplace />);
    expect(await screen.findByText("Paper Review")).toBeTruthy();
  });

  it("tells expert consumers to refresh after installing", async () => {
    // paper-review lives in this catalog, so an expert can be installed from
    // here — and the Experts view and composer pill must not keep counting a
    // stale list afterwards.
    mockApi([row({ installed: false })]);
    const onChange = vi.fn();
    window.addEventListener("evo-teams-change", onChange);

    render(<SkillsMarketplace />);
    fireEvent.click(await screen.findByRole("button", { name: /^install$/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    window.removeEventListener("evo-teams-change", onChange);
  });

  it("tells them again after uninstalling", async () => {
    mockApi([row({ installed: true })]);
    const onChange = vi.fn();
    window.addEventListener("evo-teams-change", onChange);

    render(<SkillsMarketplace />);
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
