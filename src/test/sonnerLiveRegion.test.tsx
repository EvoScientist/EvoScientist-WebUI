// @vitest-environment jsdom
//
// The "Not sent" notice says "Copied." only through sonner's own live region
// (CopyLeftOut in ChatInterface): a status of its own inside it could be read
// twice. The chat tests mock sonner, so this pins what the notice relies on
// in the real one: the toaster is a polite region that reads added text, and
// a toast adds no region of its own.

import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Toaster, toast } from "sonner";

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
});

describe("sonner's toaster as the notice's live region", () => {
  it("is polite and reads added text, and a toast adds no region", async () => {
    render(<Toaster />);
    act(() => {
      toast.info("Not sent: /goal pause", {
        duration: Infinity,
        description: <span data-testid="said">Copied.</span>,
      });
    });
    const said = await screen.findByTestId("said");
    const region = said.closest("[aria-live]");
    expect(region?.tagName).toBe("SECTION");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.getAttribute("aria-relevant")?.split(" ")).toEqual(
      expect.arrayContaining(["additions", "text"])
    );
    expect(region?.getAttribute("aria-atomic")).toBe("false");
    // No live region inside it, by attribute or by role (log, marquee and
    // timer are live regions too, and so is <output>).
    expect(
      region?.querySelectorAll(
        '[aria-live], [role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"], output'
      )
    ).toHaveLength(0);
  });
});
