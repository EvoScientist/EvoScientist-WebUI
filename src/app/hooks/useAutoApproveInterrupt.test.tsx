// @vitest-environment jsdom
//
// Auto-approve resumes an interrupt once; a resume the chat can't start yet
// is not counted, so it happens once the chat can.

import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useAutoApproveInterrupt } from "./useAutoApproveInterrupt";

const interrupt = {
  id: "int-1",
  value: { action_requests: [{ name: "read_file", args: { path: "a.md" } }] },
};

describe("useAutoApproveInterrupt", () => {
  it("resumes once the chat can, not counting a refused try", () => {
    const resumeInterrupt = vi.fn();
    let ready = false;
    const props = {
      autoApprove: true,
      interrupt,
      resumeInterrupt,
      isLoading: false,
      resetKey: "thread-1",
      canResumeNow: () => ready,
    };
    const { rerender } = renderHook((p) => useAutoApproveInterrupt(p), {
      initialProps: props,
    });
    expect(resumeInterrupt).not.toHaveBeenCalled();

    ready = true;
    // The chat re-renders when it can run (its rendered state changed).
    rerender({ ...props, canResumeNow: () => ready });

    expect(resumeInterrupt).toHaveBeenCalledTimes(1);
  });
});
