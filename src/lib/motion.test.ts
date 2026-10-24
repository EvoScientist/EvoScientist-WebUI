// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { canAnimate, prefersReducedMotion } from "./motion";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prefersReducedMotion", () => {
  it("is false where the media query can't be asked", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("follows the media query", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
    }));
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("canAnimate", () => {
  it("is false without an element or without the Web Animations API", () => {
    expect(canAnimate(null)).toBe(false);
    // jsdom has no element.animate.
    expect(canAnimate(document.createElement("div"))).toBe(false);
  });

  it("is true for an element that can animate", () => {
    const el = document.createElement("div");
    Object.assign(el, { animate: () => ({}) });
    expect(canAnimate(el)).toBe(true);
  });
});
