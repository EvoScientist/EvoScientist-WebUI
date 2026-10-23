// @vitest-environment jsdom
//
// The Settings page's "This browser" group: the deployment URL this page
// talks to and the chat display preference, both kept in this browser.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { BrowserSettings } from "./BrowserSettings";
import { useCollapseAgentActions } from "@/lib/uiSettings";

const CURRENT = "http://127.0.0.1:6174";

function renderSettings(
  props: Partial<{ hasUnsavedEdits: boolean; saving: boolean }> = {}
) {
  const onSave = vi.fn();
  render(
    <BrowserSettings
      deploymentUrl={CURRENT}
      onSaveDeploymentUrl={onSave}
      hasUnsavedEdits={props.hasUnsavedEdits ?? false}
      saving={props.saving ?? false}
    />
  );
  return onSave;
}

const urlInput = () =>
  screen.getByLabelText("Deployment URL") as HTMLInputElement;
const saveButton = () =>
  screen.getByRole("button", { name: "Save deployment URL" });
const type = (value: string) =>
  fireEvent.change(urlInput(), { target: { value } });

beforeEach(() => {
  localStorage.clear();
});

describe("BrowserSettings connection", () => {
  it("refuses an empty address and keeps focus on it", () => {
    const onSave = renderSettings();
    type("");
    fireEvent.click(saveButton());
    expect(screen.getByRole("alert").textContent).toBe(
      "Enter your deployment URL to continue."
    );
    expect(onSave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(urlInput());
  });

  it("refuses text that is not a URL", () => {
    const onSave = renderSettings();
    type("not a url");
    fireEvent.click(saveButton());
    expect(screen.getByRole("alert").textContent).toBe(
      "Enter a valid URL, e.g. http://127.0.0.1:6174"
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves a valid address, trimmed", () => {
    const onSave = renderSettings();
    type(" http://127.0.0.1:7000 ");
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:7000");
  });

  it("does nothing for the same address", () => {
    const onSave = renderSettings();
    type("http://127.0.0.1:6174/");
    fireEvent.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves on Enter but not while composing", () => {
    const onSave = renderSettings();
    type("http://127.0.0.1:7000");
    fireEvent.keyDown(urlInput(), { key: "Enter", isComposing: true });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(urlInput(), { key: "Enter" });
    expect(onSave).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:7000");
  });

  it("asks before dropping unsaved General edits", async () => {
    const onSave = renderSettings({ hasUnsavedEdits: true });
    type("http://127.0.0.1:7000");
    fireEvent.click(saveButton());
    expect(
      await screen.findByText("Discard unsaved changes in General?")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }));
    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(saveButton()));

    fireEvent.click(saveButton());
    fireEvent.click(
      await screen.findByRole("button", { name: "Discard and connect" })
    );
    expect(onSave).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:7000");
  });

  it("cannot save the address while EvoScientist is saving", () => {
    renderSettings({ saving: true });
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  // A switch remounts the page, so the user would never see how the
  // General save ended.
  it("does not switch on Enter while EvoScientist is saving", () => {
    const onSave = renderSettings({ saving: true });
    type("http://127.0.0.1:7000");
    fireEvent.keyDown(urlInput(), { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("cannot discard and connect once General starts saving", async () => {
    const onSave = vi.fn();
    const props = { deploymentUrl: CURRENT, onSaveDeploymentUrl: onSave };
    const { rerender } = render(
      <BrowserSettings
        {...props}
        hasUnsavedEdits
        saving={false}
      />
    );
    type("http://127.0.0.1:7000");
    fireEvent.click(saveButton());
    const discard = await screen.findByRole("button", {
      name: "Discard and connect",
    });
    rerender(
      <BrowserSettings
        {...props}
        hasUnsavedEdits
        saving
      />
    );
    expect((discard as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(discard);
    expect(onSave).not.toHaveBeenCalled();
  });

  // Safari sends the Enter that ends an IME composition with keyCode 229 and
  // isComposing false (the #85 rename guard).
  it("does not save on the Enter that ends a Safari IME composition", () => {
    const onSave = renderSettings();
    type("http://127.0.0.1:7000");
    fireEvent.keyDown(urlInput(), { key: "Enter", keyCode: 229 });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("follows a new deployment URL from its parent", () => {
    const onSave = vi.fn();
    const props = {
      onSaveDeploymentUrl: onSave,
      hasUnsavedEdits: false,
      saving: false,
    };
    const { rerender } = render(
      <BrowserSettings
        deploymentUrl={CURRENT}
        {...props}
      />
    );
    rerender(
      <BrowserSettings
        deploymentUrl="http://127.0.0.1:7000"
        {...props}
      />
    );
    expect(urlInput().value).toBe("http://127.0.0.1:7000");
  });
});

describe("BrowserSettings display", () => {
  it("applies the display preference at once", () => {
    renderSettings();
    const reader = renderHook(() => useCollapseAgentActions());
    expect(reader.result.current.value).toBe(true);
    act(() => {
      fireEvent.click(
        screen.getByLabelText("Collapse agent actions by default")
      );
    });
    expect(reader.result.current.value).toBe(false);
  });
});
