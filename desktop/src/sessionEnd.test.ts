import { describe, expect, it, vi } from "vitest";
import { SESSION_QUERY_GRACE_MS, SessionEnd } from "./sessionEnd";

function setup() {
  let t = 1_000;
  const timers: { fn: () => void; at: number }[] = [];
  const s = new SessionEnd(
    () => t,
    (fn, ms) => void timers.push({ fn, at: t + ms })
  );
  const advance = (ms: number) => {
    t += ms;
    for (const x of timers.filter((x) => x.at <= t)) {
      timers.splice(timers.indexOf(x), 1);
      x.fn();
    }
  };
  return { s, advance, timers };
}

describe("SessionEnd", () => {
  it("shows an error at once when no session-end question came", () => {
    const { s } = setup();
    const show = vi.fn();
    expect(s.report(show)).toBe("now");
    expect(show).toHaveBeenCalledOnce();
  });

  it("drops an exit right after the question when session-end follows (a sign-out)", () => {
    const { s, advance } = setup();
    const show = vi.fn();
    s.queried();
    advance(100);
    expect(s.report(show)).toBe("deferred");
    advance(200);
    s.end();
    advance(SESSION_QUERY_GRACE_MS);
    expect(show).not.toHaveBeenCalled();
    expect(s.report(show)).toBe("dropped");
  });

  it("shows it after the grace period when the sign-out was cancelled", () => {
    const { s, advance } = setup();
    const show = vi.fn();
    s.queried();
    advance(100);
    s.report(show);
    advance(SESSION_QUERY_GRACE_MS - 200);
    expect(show).not.toHaveBeenCalled();
    advance(100);
    expect(show).toHaveBeenCalledOnce();
  });

  it("shows later exits at once once the grace period is over", () => {
    const { s, advance } = setup();
    const show = vi.fn();
    s.queried();
    advance(SESSION_QUERY_GRACE_MS);
    expect(s.report(show)).toBe("now");
    expect(show).toHaveBeenCalledOnce();
  });
});
