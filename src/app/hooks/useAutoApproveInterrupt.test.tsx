// @vitest-environment jsdom
//
// Auto-approve resumes an interrupt once. The chat hands it the interrupt
// only while it can run, and checks again at the moment of resuming; a
// resume refused at that moment is not counted, so it happens once the chat
// can run again.

import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useAutoApproveInterrupt } from "./useAutoApproveInterrupt";

const interrupt = {
  id: "int-1",
  value: { action_requests: [{ name: "read_file", args: { path: "a.md" } }] },
};

describe("useAutoApproveInterrupt", () => {
  it("resumes once the chat can run, after a refused try", () => {
    const resumeInterrupt = vi.fn();
    let ready = false;
    // Stable, like useChat's canRunNow.
    const canResumeNow = () => ready;
    const props = (canSend: boolean) => ({
      autoApprove: true,
      // As ChatInterface passes it: only while the chat can run.
      interrupt: canSend ? interrupt : undefined,
      resumeInterrupt,
      isLoading: false,
      resetKey: "thread-1",
      canResumeNow,
    });
    // Rendered as runnable, but the gate closed in the same tick.
    const { rerender } = renderHook((p) => useAutoApproveInterrupt(p), {
      initialProps: props(true),
    });
    expect(resumeInterrupt).not.toHaveBeenCalled();

    // The re-read renders (can't run), then its answer renders (can run).
    rerender(props(false));
    ready = true;
    rerender(props(true));

    expect(resumeInterrupt).toHaveBeenCalledTimes(1);
  });
});
