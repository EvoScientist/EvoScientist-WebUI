// @vitest-environment jsdom
//
// The desktop app's update offer in the WebUI (W04), with the real sonner
// toaster: Download, the progress, Restart to update and what a refused
// restart says. In a plain browser nothing shows.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { DesktopUpdateNotice } from "@/app/components/DesktopUpdateNotice";
import type { AppUpdateState } from "@/lib/desktop";

function fakeApp(initial: AppUpdateState) {
  let send: (s: AppUpdateState) => void = () => {};
  let current = initial;
  const appUpdate = {
    state: vi.fn(async () => current),
    onState: vi.fn((cb: (s: AppUpdateState) => void) => {
      send = cb;
      return () => {};
    }),
    download: vi.fn(async () => {}),
    restartToUpdate: vi.fn(async () => ({ ok: false, code: "busy" })),
  };
  window.evoscientistDesktop = { appUpdate };
  return {
    appUpdate,
    send: (s: AppUpdateState) =>
      act(() => {
        current = s;
        send(s);
      }),
  };
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
  // sonner removes a dismissed toast by id after an animation frame and
  // 200 ms; unmounting the notice dismisses its id in another frame. Let all
  // of that land now, while no Toaster listens, not in the next test (same
  // id) or after the environment is torn down.
  await waitFor(
    () => expect(document.querySelector("[data-sonner-toast]")).toBeNull(),
    { timeout: 5_000 }
  );
  cleanup();
  await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
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
    // The toaster is a live region: the percent is shown, not announced.
    const title = await screen.findByText("Downloading EvoScientist 0.4.3...");
    expect(title.textContent).toBe("Downloading EvoScientist 0.4.3... 42%");
    expect(screen.getByText("42%").getAttribute("aria-hidden")).toBe("true");
    app.send({ kind: "downloading", version: "0.4.3", percent: 43 });
    await vi.waitFor(() => expect(screen.getByText("43%")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    app.send({ kind: "ready", version: "0.4.3" });
    const restart = await screen.findByRole("button", {
      name: "Restart to update",
    });
    // A second click while the first runs asks nothing more.
    fireEvent.click(restart);
    fireEvent.click(restart);
    expect(app.appUpdate.restartToUpdate).toHaveBeenCalledOnce();
    // Refused while the app is busy: the offer comes back and says why.
    expect(
      await screen.findByText("The app is busy. Try again in a moment.")
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Restart to update" })
    ).toBeTruthy();
    // Once answered, the button works again.
    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(app.appUpdate.restartToUpdate).toHaveBeenCalledTimes(2);
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

  it("offers the download again when Restart to update finds no installer", async () => {
    const app = fakeApp({ kind: "ready", version: "0.4.3" });
    app.appUpdate.restartToUpdate.mockImplementationOnce(async () => {
      // The app moved the offer back before answering.
      app.send({ kind: "available", version: "0.4.3", failed: true });
      return { ok: false, code: "not_ready" };
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart to update" })
    );
    expect(
      await screen.findByText(
        "The download of EvoScientist 0.4.3 did not finish."
      )
    ).toBeTruthy();
    expect(
      await screen.findByText(
        "The downloaded installer could not be opened. Download it again."
      )
    ).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Restart to update" })
    ).toBeNull();
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

  it("offers a version again after a check withdrew it", async () => {
    // The app's own `none` is no close by the user.
    const app = fakeApp({ kind: "available", version: "0.4.3", failed: false });
    mount();
    await screen.findByText("EvoScientist 0.4.3 is available.");
    app.send({ kind: "none" });
    await vi.waitFor(() =>
      expect(document.querySelector("[data-sonner-toast]")).toBeNull()
    );
    app.send({ kind: "available", version: "0.4.3", failed: false });
    expect(
      await screen.findByText("EvoScientist 0.4.3 is available.")
    ).toBeTruthy();
  });

  it("offers a version again at once after a check withdrew it", async () => {
    const app = fakeApp({ kind: "available", version: "0.4.3", failed: false });
    mount();
    await screen.findByText("EvoScientist 0.4.3 is available.");
    app.send({ kind: "none" });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    app.send({ kind: "available", version: "0.4.3", failed: false });
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(screen.getByText("EvoScientist 0.4.3 is available.")).toBeTruthy();
    // And it is still the user's to close: a close keeps it closed.
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await vi.waitFor(() =>
      expect(screen.queryByText("EvoScientist 0.4.3 is available.")).toBeNull()
    );
    app.send({ kind: "available", version: "0.4.3", failed: false });
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(screen.queryByText("EvoScientist 0.4.3 is available.")).toBeNull();
  });

  it("shows the next step that arrives while a closed notice is leaving", async () => {
    const app = fakeApp({ kind: "downloading", version: "0.4.3", percent: 50 });
    mount();
    await screen.findByText("Downloading EvoScientist 0.4.3...");
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    app.send({ kind: "ready", version: "0.4.3" });
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(
      screen.getByRole("button", { name: "Restart to update" })
    ).toBeTruthy();
  });
});
