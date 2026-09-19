import { describe, expect, it } from "vitest";
import {
  approvalSurface,
  bindActionRequestsToToolCalls,
  buildToolApprovalResume,
  interruptIdOf,
} from "@/lib/hitl";

describe("buildToolApprovalResume", () => {
  it("keys the response by interrupt id when present", () => {
    expect(
      buildToolApprovalResume("abc123", { decisions: [{ type: "approve" }] })
    ).toEqual({ abc123: { decisions: [{ type: "approve" }] } });
  });

  it("falls back to the flat shape without an id", () => {
    expect(
      buildToolApprovalResume(undefined, { decisions: [{ type: "approve" }] })
    ).toEqual({ decisions: [{ type: "approve" }] });
  });
});

describe("interruptIdOf", () => {
  it("reads a non-empty string id", () => {
    expect(interruptIdOf({ id: "abc", value: {} })).toBe("abc");
  });

  it("returns undefined for missing, empty, or non-string ids", () => {
    expect(interruptIdOf({ value: {} })).toBeUndefined();
    expect(interruptIdOf({ id: "" })).toBeUndefined();
    expect(interruptIdOf(null)).toBeUndefined();
    expect(interruptIdOf({ id: 42 })).toBeUndefined();
  });
});

describe("bindActionRequestsToToolCalls", () => {
  const execA = { name: "execute", args: { command: "pwd" } };
  const execB = { name: "execute", args: { command: "ls" } };

  it("binds same-named requests to interrupted tool calls in order", () => {
    const map = bindActionRequestsToToolCalls(
      [
        { id: "tc1", name: "execute", status: "interrupted" },
        { id: "tc2", name: "execute", status: "interrupted" },
      ],
      [execA, execB]
    );
    expect(map.get("tc1")).toEqual({ actionRequest: execA, actionIndex: 0 });
    expect(map.get("tc2")).toEqual({ actionRequest: execB, actionIndex: 1 });
  });

  it("ignores non-interrupted tool calls", () => {
    const map = bindActionRequestsToToolCalls(
      [{ id: "tc1", name: "execute", status: "completed" }],
      [execA]
    );
    expect(map.size).toBe(0);
  });

  it("ignores action requests whose tool name does not match", () => {
    const map = bindActionRequestsToToolCalls(
      [{ id: "tc1", name: "delete", status: "interrupted" }],
      [execA]
    );
    expect(map.size).toBe(0);
  });
});

describe("approvalSurface", () => {
  const execA = { name: "execute", args: { command: "pwd" } };
  const execB = { name: "execute", args: { command: "ls" } };

  it("is none without action requests", () => {
    expect(
      approvalSurface(
        [{ id: "tc1", name: "execute", status: "interrupted" }],
        []
      )
    ).toBe("none");
  });

  it("is inline when every request binds to a tool call", () => {
    expect(
      approvalSurface(
        [
          { id: "tc1", name: "execute", status: "interrupted" },
          { id: "tc2", name: "execute", status: "interrupted" },
        ],
        [execA, execB]
      )
    ).toBe("inline");
  });

  it("is fallback when no request binds (sub-agent interrupt)", () => {
    expect(
      approvalSurface([{ id: "tc1", name: "task", status: "pending" }], [execA])
    ).toBe("fallback");
  });

  it("is fallback when only some requests bind, so none is stranded", () => {
    // A still-running main-agent `execute` claims one of a sub-agent's two
    // `execute` requests; the second has no inline card to be decided on.
    expect(
      approvalSurface(
        [
          { id: "tc1", name: "execute", status: "interrupted" },
          { id: "tc2", name: "task", status: "pending" },
        ],
        [execA, execB]
      )
    ).toBe("fallback");
  });
});
