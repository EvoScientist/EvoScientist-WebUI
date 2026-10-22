import { describe, expect, it } from "vitest";
import {
  compareReleases,
  inRange,
  parseRange,
  parseRelease,
  placeInRange,
} from "./versions";

describe("parseRelease", () => {
  it("reads plain release numbers", () => {
    expect(parseRelease("0.3.8")).toEqual([0, 3, 8]);
    expect(parseRelease(" 1 ")).toEqual([1]);
  });

  it.each([
    "0.4.0rc1",
    "0.4.0.dev1",
    "0.3.7.post1",
    "0.3.7+local",
    "0.4.0-beta.1",
    "0.3.2-0",
    "v0.3.8",
    "",
    "x",
  ])("refuses %j", (v) => {
    expect(parseRelease(v)).toBeNull();
  });
});

describe("compareReleases", () => {
  it("pads with zeros and compares numerically", () => {
    expect(compareReleases([0, 3], [0, 3, 0])).toBe(0);
    expect(compareReleases([0, 3, 10], [0, 3, 9])).toBe(1);
    expect(compareReleases([0, 3, 9], [0, 4])).toBe(-1);
  });
});

describe("parseRange", () => {
  it("reads the core's webui_compat form", () => {
    expect(parseRange(">=0.3,<0.5")).toEqual([
      { op: ">=", release: [0, 3] },
      { op: "<", release: [0, 5] },
    ]);
  });

  it.each(["", ">=0.3,", "~=0.3", ">=0.3.*", "0.3", ">=0.3rc1"])(
    "refuses %j",
    (r) => {
      expect(parseRange(r)).toBeNull();
    }
  );
});

describe("placeInRange", () => {
  const range = ">=0.3.8,<0.4";

  it.each([
    ["0.3.8", "inside"],
    ["0.3.10", "inside"],
    ["0.3.7", "below"],
    ["0.4.0", "above"],
    ["0.4", "above"],
    ["0.3.9rc1", "invalid"],
    ["0.3.9+local", "invalid"],
  ])("%s is %s", (version, placement) => {
    expect(placeInRange(version, range)).toBe(placement);
  });

  it("places a failed == by order", () => {
    expect(placeInRange("0.3.1", "==0.3.2")).toBe("below");
    expect(placeInRange("0.3.3", "==0.3.2")).toBe("above");
  });

  it("is invalid for a range it cannot read", () => {
    expect(placeInRange("0.3.8", "~=0.3")).toBe("invalid");
  });
});

describe("inRange", () => {
  it("checks the bundled UI against the core's webui_compat", () => {
    expect(inRange("0.4.0", ">=0.3,<0.5")).toBe(true);
    expect(inRange("0.5.0", ">=0.3,<0.5")).toBe(false);
    expect(inRange("0.4.1-beta.1", ">=0.3,<0.5")).toBe(false);
  });
});
