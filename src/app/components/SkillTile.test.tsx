// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Users } from "lucide-react";

import { SkillTile } from "./SkillTile";

const base = {
  title: "Paper Review",
  description: "Adversarial self-review.",
  installed: false,
};

describe("SkillTile", () => {
  it("shows the upstream version before install and the local one after", () => {
    const { rerender } = render(
      <SkillTile
        {...base}
        latestVersion="1.3.0"
      />
    );
    expect(screen.getByText("v1.3.0")).toBeTruthy();

    rerender(
      <SkillTile
        {...base}
        installed
        installedVersion="1.2.0"
        latestVersion="1.3.0"
      />
    );
    expect(screen.getByText("v1.2.0")).toBeTruthy();
  });

  it("offers Install when absent and Uninstall once installed", () => {
    const { rerender } = render(<SkillTile {...base} />);
    expect(screen.getByRole("button", { name: /install/i })).toBeTruthy();

    rerender(
      <SkillTile
        {...base}
        installed
        onUninstall={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: /uninstall/i })).toBeTruthy();
  });

  it("falls back to placeholder text when the skill has no description", () => {
    render(
      <SkillTile
        {...base}
        description=""
      />
    );
    expect(screen.getByText("No description.")).toBeTruthy();
  });

  it("renders extra actions alongside the install controls", () => {
    const onInvite = vi.fn();
    render(
      <SkillTile
        {...base}
        installed
        onUninstall={() => {}}
        actions={
          <button
            type="button"
            onClick={onInvite}
          >
            Invite
          </button>
        }
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(onInvite).toHaveBeenCalledOnce();
    // The stock controls must survive the addition.
    expect(screen.getByRole("button", { name: /uninstall/i })).toBeTruthy();
  });
});

describe("SkillTile without an uninstall handler", () => {
  it("hides the Uninstall button rather than offering a dead action", () => {
    render(
      <SkillTile
        {...base}
        installed
      />
    );
    // Anchor on the card itself — asserting a missing control proves nothing
    // if the tile never rendered.
    expect(screen.getByText("Paper Review")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /uninstall/i })).toBeNull();
  });

  it("still hides Install for something already installed", () => {
    render(
      <SkillTile
        {...base}
        installed
      />
    );
    expect(screen.getByText("Paper Review")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^install$/i })).toBeNull();
  });
});

describe("SkillTile icon", () => {
  it("defaults to the skill icon", () => {
    const { container } = render(<SkillTile {...base} />);
    expect(container.querySelector("svg.lucide-puzzle")).toBeTruthy();
  });

  it("takes the caller's icon so Experts can mark itself apart", () => {
    render(
      <SkillTile
        {...base}
        icon={Users}
      />
    );
    expect(document.querySelector("svg.lucide-users")).toBeTruthy();
  });
});

describe("SkillTile tag", () => {
  it("draws the tag as a pill after the title", () => {
    render(
      <SkillTile
        {...base}
        installed
        tag="from memory"
      />
    );
    const tag = screen.getByText("from memory");
    expect(
      screen.getByRole("heading", { name: "Paper Review" }).nextElementSibling
    ).toBe(tag);
    expect(tag.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "rounded-full",
        "border",
        "border-solid",
        "border-[var(--brand)]",
        "bg-[var(--brand-soft)]",
        "text-[var(--brand)]",
      ])
    );
  });

  it("has no tag unless given one", () => {
    render(<SkillTile {...base} />);
    expect(
      screen.getByRole("heading", { name: "Paper Review" }).nextElementSibling
    ).toBeNull();
  });
});

describe("SkillTile without details", () => {
  // A skill whose details the page can't show (a project's own skill): no
  // "View details" control that does nothing.
  it("shows its title and text without a details button", () => {
    render(
      <SkillTile
        {...base}
        installed
        onUninstall={() => {}}
      />
    );
    expect(screen.getByRole("heading", { name: "Paper Review" })).toBeTruthy();
    expect(screen.getByText("Adversarial self-review.")).toBeTruthy();
    expect(screen.queryByTitle("View details")).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Uninstall",
    ]);
  });

  it("keeps the details button when it can open them", () => {
    const onOpen = vi.fn();
    render(
      <SkillTile
        {...base}
        onOpen={onOpen}
      />
    );
    fireEvent.click(screen.getByTitle("View details"));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
