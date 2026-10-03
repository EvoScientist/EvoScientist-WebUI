// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { FilePreviewPane } from "./FilePreviewPane";
import { renderWithFilePane } from "@/test/filePaneHarness";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = new URL(String(input), "http://localhost").searchParams.get(
        "path"
      );
      return new Response(`content of ${path}`, {
        headers: { "content-length": "20" },
      });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const openWs = (h: ReturnType<typeof renderWithFilePane>, path: string) =>
  act(() => h.pane().open({ source: "workspace", path }));

describe("FilePreviewPane", () => {
  it("shows a tab per file and the shown file's view", async () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "a.md");
    openWs(h, "b.md");
    const tabs = within(screen.getByRole("tablist", { name: "Open files" }));
    expect(tabs.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "a.md",
      "b.md",
    ]);
    expect(await screen.findByText("content of b.md")).toBeTruthy();
    // The other tab stays mounted, just hidden.
    const a = await screen.findByText("content of a.md");
    expect(a.closest("[hidden]")).not.toBeNull();

    fireEvent.click(tabs.getByRole("tab", { name: "a.md" }));
    expect(h.pane().state.activeId).toBe("workspace:a.md");
  });

  it("closes clean tabs at once and goes back to the tree after the last", () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "a.md");
    fireEvent.click(screen.getByRole("button", { name: "Close a.md" }));
    expect(h.pane().state.tabs).toEqual([]);
    expect(h.pane().state.mode).toBe("tree");
  });

  it("asks before closing a tab with unsaved edits", async () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "a.md");
    act(() => h.pane().setDirty("workspace:a.md", true));
    h.pane().drafts.set("workspace:a.md", { text: "draft", base: "" });

    fireEvent.click(screen.getByRole("button", { name: "Close a.md" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep Editing" })
    );
    expect(h.pane().state.tabs).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Close a.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(h.pane().state.tabs).toEqual([]));
    expect(h.pane().drafts.get("workspace:a.md")).toBeUndefined();
  });

  it("re-opening a file keeps its draft", async () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "a.md");
    fireEvent.click(await screen.findByRole("button", { name: "Edit file" }));
    fireEvent.change(screen.getByLabelText("File content"), {
      target: { value: "my draft" },
    });
    openWs(h, "b.md");
    openWs(h, "a.md");
    expect(
      (screen.getByLabelText("File content") as HTMLTextAreaElement).value
    ).toBe("my draft");
  });

  it("goes back to the tree without closing tabs", () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "a.md");
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    expect(h.pane().state.mode).toBe("tree");
    expect(h.pane().state.tabs).toHaveLength(1);
  });
});
