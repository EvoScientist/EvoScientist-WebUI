// @vitest-environment jsdom
//
// The one place the two galleries differ: Research Skills shows a skill's
// SKILL.md (the method), Experts shows its EXPERT.md (the persona and the
// result-envelope contract the expert runs under).

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("./MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { SkillDetailDialog } from "./SkillDetailDialog";

const target = {
  name: "paper-review",
  title: "Paper Review",
  description: "Adversarial self-review.",
  installed: true,
};

function mockDetail(body: string, expertBody?: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ ...target, body, expertBody, version: "1.2.0" }),
      })
    )
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("SkillDetailDialog", () => {
  it("shows the skill's method by default", async () => {
    mockDetail("THE METHOD", "THE PERSONA");
    render(
      <SkillDetailDialog
        skill={target}
        onClose={() => {}}
      />
    );
    await waitFor(() => expect(screen.getByText("THE METHOD")).toBeTruthy());
    expect(screen.queryByText("THE PERSONA")).toBeNull();
  });

  it("shows the actor definition when opened as an expert", async () => {
    mockDetail("THE METHOD", "THE PERSONA");
    render(
      <SkillDetailDialog
        skill={target}
        preferExpert
        onClose={() => {}}
      />
    );
    await waitFor(() => expect(screen.getByText("THE PERSONA")).toBeTruthy());
    expect(screen.queryByText("THE METHOD")).toBeNull();
  });

  it("falls back to the method when an expert has no actor definition", async () => {
    // A deployment can report an expert the local tier cannot read (builtin or
    // workspace tier), so the persona may be missing — degrade, don't blank.
    mockDetail("THE METHOD", undefined);
    render(
      <SkillDetailDialog
        skill={target}
        preferExpert
        onClose={() => {}}
      />
    );
    await waitFor(() => expect(screen.getByText("THE METHOD")).toBeTruthy());
  });
});
