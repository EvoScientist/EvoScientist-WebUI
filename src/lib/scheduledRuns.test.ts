import { describe, expect, it } from "vitest";
import { canStillProduceSteps } from "./scheduledRuns";

describe("canStillProduceSteps", () => {
  it("is false only once a scheduled run has clearly ended", () => {
    expect(canStillProduceSteps("success")).toBe(false);
    expect(canStillProduceSteps("error")).toBe(false);
    expect(canStillProduceSteps("timeout")).toBe(false);
  });

  it("stays true while a run is going or waiting on the user", () => {
    expect(canStillProduceSteps("pending")).toBe(true);
    expect(canStillProduceSteps("running")).toBe(true);
    // An interrupted scheduled run may be paused on an approval ("Open
    // conversation to respond") — its steps are not dead.
    expect(canStillProduceSteps("interrupted")).toBe(true);
  });
});
