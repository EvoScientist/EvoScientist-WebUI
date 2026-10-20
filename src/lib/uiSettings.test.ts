// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCollapseAgentActions } from "./uiSettings";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useCollapseAgentActions", () => {
  // A browser that blocks site data throws on any storage access.
  it("keeps working when browser storage refuses it", () => {
    const refuse = () => {
      throw new DOMException("Storage is disabled.", "SecurityError");
    };
    vi.stubGlobal("localStorage", {
      getItem: refuse,
      setItem: refuse,
      removeItem: refuse,
    });
    const { result } = renderHook(() => useCollapseAgentActions());
    expect(result.current.value).toBe(true);

    act(() => result.current.setValue(false));
    expect(result.current.value).toBe(false);
  });
});
