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

  // The chat stays mounted while Settings is open, so a change made there has
  // to reach it without a reload; `storage` events only fire in other tabs.
  it("shows a change to every reader in the same tab", () => {
    const a = renderHook(() => useCollapseAgentActions());
    const b = renderHook(() => useCollapseAgentActions());
    act(() => a.result.current.setValue(false));
    expect(b.result.current.value).toBe(false);
    act(() => a.result.current.setValue(true));
    expect(b.result.current.value).toBe(true);
  });

  it("shows a change to every reader also when storage refuses it", () => {
    const refuse = () => {
      throw new DOMException("Storage is disabled.", "SecurityError");
    };
    vi.stubGlobal("localStorage", {
      getItem: refuse,
      setItem: refuse,
      removeItem: refuse,
    });
    const a = renderHook(() => useCollapseAgentActions());
    const b = renderHook(() => useCollapseAgentActions());
    act(() => a.result.current.setValue(false));
    expect(b.result.current.value).toBe(false);
  });
});
