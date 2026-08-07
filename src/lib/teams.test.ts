import { describe, expect, it } from "vitest";
import { formatTeamName, ACTIVE_TEAMS_METADATA_KEY } from "./teams";

describe("formatTeamName", () => {
  it("title-cases a single kebab-cased word", () => {
    expect(formatTeamName("brainstorm")).toBe("Brainstorm");
  });

  it("title-cases each token in a multi-word kebab name", () => {
    expect(formatTeamName("idea-brainstorm")).toBe("Idea Brainstorm");
    expect(formatTeamName("literature-review-team")).toBe(
      "Literature Review Team"
    );
  });

  it("skips empty tokens from repeated dashes", () => {
    expect(formatTeamName("draft--reviewer")).toBe("Draft Reviewer");
    expect(formatTeamName("-leading-dash")).toBe("Leading Dash");
  });

  it("returns empty for an empty string", () => {
    expect(formatTeamName("")).toBe("");
  });
});

describe("ACTIVE_TEAMS_METADATA_KEY", () => {
  it("is the wire-compatible thread metadata key", () => {
    // Backend's ActiveTeamMiddleware reads this key off thread metadata; changing
    // the string here silently breaks the summon UX end-to-end. Pinned to make
    // the coupling explicit.
    expect(ACTIVE_TEAMS_METADATA_KEY).toBe("active_teams");
  });
});
