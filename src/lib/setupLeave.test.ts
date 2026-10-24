import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLeaveTracker } from "./setupLeave";

const A = "http://127.0.0.1:6174";
const B = "http://127.0.0.1:6175";

function setup() {
  const record = vi.fn();
  const state = { view: null as string | null, urlView: null as string | null };
  const tracker = createLeaveTracker({
    record,
    viewNow: () => state.view,
    urlViewNow: () => state.urlView,
  });
  return { record, state, tracker };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createLeaveTracker", () => {
  it("counts a leave once the view stays outside Setup and Settings", () => {
    const { record, tracker } = setup();
    tracker.leave(A);
    expect(record).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(record).toHaveBeenCalledExactlyOnceWith(A);
  });

  // A render can still report the old view right after setView("setup").
  it("drops a flicker: the view is back on Setup before the leave settles", () => {
    const { record, state, tracker } = setup();
    tracker.leave(A);
    state.view = "setup";
    tracker.back(A);
    vi.advanceTimersByTime(2000);
    expect(record).not.toHaveBeenCalled();
  });

  it("drops the leave when the view is back by the time it settles", () => {
    const { record, state, tracker } = setup();
    tracker.leave(A);
    state.view = "settings";
    vi.advanceTimersByTime(2000);
    expect(record).not.toHaveBeenCalled();
  });

  // nuqs writes the URL up to 3 x its throttle later (960 ms on older Safari).
  it("waits for the URL to leave Setup too", () => {
    const { record, state, tracker } = setup();
    state.urlView = "setup";
    tracker.leave(A);
    vi.advanceTimersByTime(960);
    expect(record).not.toHaveBeenCalled();
    state.urlView = null;
    vi.advanceTimersByTime(150);
    expect(record).toHaveBeenCalledExactlyOnceWith(A);
  });

  // The address bar is the truth: still on Setup after nuqs' slowest write
  // means the user is on Setup, and a reload would open it.
  it("drops the leave when the URL never leaves Setup", () => {
    const { record, state, tracker } = setup();
    state.urlView = "setup";
    tracker.leave(A);
    vi.advanceTimersByTime(5000);
    expect(record).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps another backend's leave when Setup opens for a new one", () => {
    const { record, state, tracker } = setup();
    tracker.leave(A);
    state.view = "setup";
    tracker.back(B);
    expect(record).toHaveBeenCalledExactlyOnceWith(A);
    vi.advanceTimersByTime(2000);
    expect(record).toHaveBeenCalledOnce();
  });

  it("keeps a leave still waiting when another one starts", () => {
    const { record, tracker } = setup();
    tracker.leave(A);
    tracker.leave(B);
    expect(record).toHaveBeenCalledExactlyOnceWith(A);
    vi.advanceTimersByTime(150);
    expect(record).toHaveBeenLastCalledWith(B);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("keeps a pending leave when the page goes away", () => {
    const { record, tracker } = setup();
    tracker.leave(A);
    tracker.flush();
    expect(record).toHaveBeenCalledExactlyOnceWith(A);
    vi.advanceTimersByTime(2000);
    expect(record).toHaveBeenCalledOnce();
  });

  it("drops a stale render when the page goes away with the URL on Setup", () => {
    const { record, state, tracker } = setup();
    state.urlView = "setup";
    tracker.leave(A);
    tracker.flush();
    vi.advanceTimersByTime(2000);
    expect(record).not.toHaveBeenCalled();
  });

  it("drops a flicker in progress when the page goes away", () => {
    const { record, state, tracker } = setup();
    tracker.leave(A);
    state.view = "setup";
    tracker.flush();
    vi.advanceTimersByTime(2000);
    expect(record).not.toHaveBeenCalled();
  });
});
