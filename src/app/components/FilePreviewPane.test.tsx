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

  it("moves between tabs with the arrow keys, Home and End", () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "a.md");
    openWs(h, "b.md");
    openWs(h, "c.md");
    const tab = (name: string) => screen.getByRole("tab", { name });
    // One tab stop: the shown file's tab.
    expect(["a.md", "b.md", "c.md"].map((n) => tab(n).tabIndex)).toEqual([
      -1, -1, 0,
    ]);

    act(() => tab("c.md").focus());
    fireEvent.keyDown(tab("c.md"), { key: "ArrowRight" });
    expect(h.pane().state.activeId).toBe("workspace:a.md");
    expect(document.activeElement).toBe(tab("a.md"));
    fireEvent.keyDown(tab("a.md"), { key: "ArrowLeft" });
    expect(h.pane().state.activeId).toBe("workspace:c.md");
    expect(document.activeElement).toBe(tab("c.md"));
    fireEvent.keyDown(tab("c.md"), { key: "Home" });
    expect(document.activeElement).toBe(tab("a.md"));
    fireEvent.keyDown(tab("a.md"), { key: "End" });
    expect(document.activeElement).toBe(tab("c.md"));
    expect(h.pane().state.activeId).toBe("workspace:c.md");
  });

  it("closes the focused tab with Delete or Backspace and asks for focus", () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "a.md");
    openWs(h, "b.md");
    openWs(h, "c.md");
    fireEvent.click(screen.getByRole("tab", { name: "b.md" }));
    h.pane().takeFocusRequest(); // the opens' own

    fireEvent.keyDown(screen.getByRole("tab", { name: "b.md" }), {
      key: "Delete",
    });
    expect(h.pane().state.tabs.map((t) => t.path)).toEqual(["a.md", "c.md"]);
    // The inspector moves focus to what it shows next.
    expect(h.pane().takeFocusRequest()).toBe(true);

    fireEvent.keyDown(screen.getByRole("tab", { name: "a.md" }), {
      key: "Backspace",
    });
    expect(h.pane().state.tabs.map((t) => t.path)).toEqual(["c.md"]);
    expect(h.pane().takeFocusRequest()).toBe(true);
  });

  it("asks before Delete closes unsaved edits, then gives focus back", async () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "a.md");
    openWs(h, "b.md");
    act(() => h.pane().setDirty("workspace:b.md", true));
    const tab = screen.getByRole("tab", { name: "b.md, unsaved changes" });
    act(() => tab.focus());
    h.pane().takeFocusRequest();

    fireEvent.keyDown(tab, { key: "Delete" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep Editing" })
    );
    await waitFor(() => expect(document.activeElement).toBe(tab));
    expect(h.pane().state.tabs).toHaveLength(2);
    expect(h.pane().takeFocusRequest()).toBe(false);

    fireEvent.keyDown(tab, { key: "Delete" });
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(h.pane().state.tabs.map((t) => t.path)).toEqual(["a.md"]);
    // The tab is gone: the inspector picks what gets focus.
    await waitFor(() => expect(h.pane().takeFocusRequest()).toBe(true));
  });

  it("lets the inspector pick focus after the dialog when nothing had it", async () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "a.md");
    act(() => h.pane().setDirty("workspace:a.md", true));
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    h.pane().takeFocusRequest();

    // A click that doesn't move focus, as in Safari.
    fireEvent.click(screen.getByRole("button", { name: "Close a.md" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep Editing" })
    );
    await waitFor(() => expect(h.pane().takeFocusRequest()).toBe(true));
  });

  it("links each tab to its panel", () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "my notes.md");
    openWs(h, "b.md");
    for (const name of ["my notes.md", "b.md"]) {
      const tab = screen.getByRole("tab", { name });
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      expect(panelId).not.toMatch(/\s/);
      const panel = document.getElementById(panelId!);
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
    }
  });

  it("names a tab with unsaved changes as such", () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "a.md");
    act(() => h.pane().setDirty("workspace:a.md", true));
    expect(
      screen.getByRole("tab", { name: "a.md, unsaved changes" })
    ).toBeTruthy();
  });

  it("keeps only the shown tab's close button in the Tab order", () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "a.md");
    openWs(h, "b.md");
    const close = (name: string) =>
      screen.getByRole("button", { name: `Close ${name}` }).tabIndex;
    expect([close("a.md"), close("b.md")]).toEqual([-1, 0]);
  });

  it("describes each tab by its path", () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "docs/README.md");
    openWs(h, "src/README.md");
    for (const path of ["docs/README.md", "src/README.md"]) {
      expect(
        screen.getByRole("tab", { name: "README.md", description: path })
      ).toBeTruthy();
    }
  });

  it("lets keys it doesn't use through", () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "a.md");
    openWs(h, "b.md");
    const tab = screen.getByRole("tab", { name: "b.md" });
    // fireEvent returns false when the handler prevented the default.
    for (const key of ["Tab", "Enter", " ", "a"]) {
      expect(fireEvent.keyDown(tab, { key })).toBe(true);
    }
    expect(fireEvent.keyDown(tab, { key: "ArrowLeft" })).toBe(false);
    expect(h.pane().state.tabs).toHaveLength(2);
  });

  it("asks for focus when a close button that had it closes its tab", () => {
    const h = renderWithFilePane(<FilePreviewPane />);
    openWs(h, "a.md");
    openWs(h, "b.md");
    h.pane().takeFocusRequest();
    // A click that focuses the button (Chrome), on a tab not shown.
    const close = screen.getByRole("button", { name: "Close a.md" });
    act(() => close.focus());
    fireEvent.click(close);
    expect(h.pane().state.tabs.map((t) => t.path)).toEqual(["b.md"]);
    expect(h.pane().takeFocusRequest()).toBe(true);
  });

  it("leaves focus alone when a click on a close button didn't take it", () => {
    const h = renderWithFilePane(
      <>
        <textarea aria-label="Editor" />
        <FilePreviewPane />
      </>
    );
    openWs(h, "a.md");
    openWs(h, "b.md");
    h.pane().takeFocusRequest();
    act(() => screen.getByRole("textbox", { name: "Editor" }).focus());
    // A click that doesn't move focus, as in Safari.
    fireEvent.click(screen.getByRole("button", { name: "Close a.md" }));
    expect(h.pane().state.tabs.map((t) => t.path)).toEqual(["b.md"]);
    expect(h.pane().takeFocusRequest()).toBe(false);
  });
});
