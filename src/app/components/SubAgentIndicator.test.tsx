// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SubAgentIndicator } from "./SubAgentIndicator";
import type { SubAgent } from "@/app/types/types";

const subAgent = (status: SubAgent["status"]): SubAgent => ({
  id: "tc1",
  name: "task",
  subAgentName: "code-agent",
  input: { description: "do it" },
  status,
});

describe("SubAgentIndicator", () => {
  it("spins while the sub-agent is running", () => {
    const { container } = render(
      <SubAgentIndicator
        subAgent={subAgent("active")}
        onToggle={() => {}}
      />
    );
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.getByLabelText("code-agent subagent running")).toBeTruthy();
  });

  it("shows a stopped sub-agent as stopped, not running", () => {
    const { container } = render(
      <SubAgentIndicator
        subAgent={subAgent("stopped")}
        onToggle={() => {}}
      />
    );
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.getByLabelText("code-agent subagent stopped")).toBeTruthy();
  });
});
