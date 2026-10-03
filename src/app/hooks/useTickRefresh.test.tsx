// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTickRefresh } from "./useTickRefresh";

describe("useTickRefresh", () => {
  it("refreshes on a new tick only while visible, catching up when shown", () => {
    const onRefresh = vi.fn();
    const { rerender } = renderHook(
      ({ visible, tick }) => useTickRefresh(visible, tick, onRefresh),
      { initialProps: { visible: true, tick: 0 } }
    );
    expect(onRefresh).not.toHaveBeenCalled();
    rerender({ visible: true, tick: 1 });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    rerender({ visible: false, tick: 2 });
    rerender({ visible: false, tick: 3 });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    rerender({ visible: true, tick: 3 });
    expect(onRefresh).toHaveBeenCalledTimes(2);
    rerender({ visible: true, tick: 3 });
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });
});
