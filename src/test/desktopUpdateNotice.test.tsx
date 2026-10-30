// @vitest-environment jsdom
//
// The desktop app's update offer in the WebUI (W04), with the real sonner
// toaster: Download, the progress, Restart to update and what a refused
// restart says. In a plain browser nothing shows.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { DesktopUpdateNotice } from "@/app/components/DesktopUpdateNotice";
import type { AppUpdateState } from "@/lib/desktop";

function fakeApp(initial: AppUpdateState) {
  let send: (s: AppUpdateState) => void = () => {};
  const appUpdate = {
    state: vi.fn(async () => initial),
    onState: vi.fn((cb: (s: AppUpdateState) => void) => {
      send = cb;
      return () => {};
    }),
    download: vi.fn(async () => {}),
    restartToUpdate: vi.fn(async () => ({ ok: false, code: "busy" })),
  };
  window.evoscientistDesktop = { appUpdate };
  return { appUpdate, send: (s: AppUpdateState) => act(() => send(s)) };
}

function mount() {
  return render(
    <>
      <Toaster closeButton />
      <DesktopUpdateNotice />
    </>
  );
}

afterEach(async () => {
  act(() => {
    toast.dismiss();
  });
  // sonner removes a dismissed toast by id 200 ms later: let that happen
  // now, not in the next test (same id) or after the environment is gone.
  await act(() => new Promise((r) => setTimeout(r, 300)));
  delete window.evoscientistDesktop;
});

describe("DesktopUpdateNotice", () => {
  it("shows nothing in a plain browser", async () => {
    mount();
    await act(async () => {});
    expect(screen.queryByText(/EvoScientist/)).toBeNull();
  });

  it("offers Download, shows the progress, then Restart to update", async () => {
    const app = fakeApp({ kind: "available", version: "0.4.3", failed: false });
    mount();
    expect(
      await screen.findByText("EvoScientist 0.4.3 is available.")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(app.appUpdate.download).toHaveBeenCalledOnce();
    app.send({ kind: "downloading", version: "0.4.3", percent: 42 });
    expect(
      await screen.findByText("Downloading EvoScientist 0.4.3... 42%")
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    app.send({ kind: "ready", version: "0.4.3" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart to update" })
    );
    expect(app.appUpdate.restartToUpdate).toHaveBeenCalledOnce();
    // Refused while the app is busy: the offer comes back and says why.
    expect(
      await screen.findByText("The app is busy. Try again in a moment.")
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Restart to update" })
    ).toBeTruthy();
  });

  it("keeps the notice when a cached download is ready at once", async () => {
    // A download already in the app's cache: downloading and ready arrive
    // within milliseconds of the click, inside sonner's 200 ms exit of a
    // toast whose action was clicked.
    const app = fakeApp({ kind: "available", version: "0.4.3", failed: false });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    app.send({ kind: "downloading", version: "0.4.3", percent: 0 });
    app.send({ kind: "ready", version: "0.4.3" });
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(
      screen.getByText("EvoScientist 0.4.3 is ready to install.")
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Restart to update" })
    ).toBeTruthy();
  });

  it("says when a download did not finish", async () => {
    fakeApp({ kind: "available", version: "0.4.3", failed: true });
    mount();
    expect(
      await screen.findByText(
        "The download of EvoScientist 0.4.3 did not finish."
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });

  it("stays closed until the next step, and goes when nothing is offered", async () => {
    const app = fakeApp({ kind: "available", version: "0.4.3", failed: false });
    mount();
    await screen.findByText("EvoScientist 0.4.3 is available.");
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await vi.waitFor(() =>
      expect(screen.queryByText("EvoScientist 0.4.3 is available.")).toBeNull()
    );
    app.send({ kind: "available", version: "0.4.3", failed: false });
    await act(async () => {});
    expect(screen.queryByText("EvoScientist 0.4.3 is available.")).toBeNull();
    app.send({ kind: "available", version: "0.4.4", failed: false });
    expect(
      await screen.findByText("EvoScientist 0.4.4 is available.")
    ).toBeTruthy();
    app.send({ kind: "none" });
    await vi.waitFor(() =>
      expect(screen.queryByText("EvoScientist 0.4.4 is available.")).toBeNull()
    );
  });
});
