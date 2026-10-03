// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { FILE_LINK_EVENT } from "@/lib/fileLink";
import { renderWithFilePane } from "@/test/filePaneHarness";
import type { ChatFilesBridge } from "./filePaneContext";

const bridge = (
  threadId: string | null,
  files: Record<string, string> = {}
): ChatFilesBridge => ({
  threadId,
  files,
  setFiles: async () => {},
  editDisabled: false,
});

const clickLink = (kind: "workspace" | "memory", path: string) =>
  act(() => {
    window.dispatchEvent(
      new CustomEvent(FILE_LINK_EVENT, {
        detail: { kind, display: path, path },
      })
    );
  });

describe("FilePaneProvider", () => {
  it("opens a chat file link as a tab and reveals the inspector", async () => {
    const onReveal = vi.fn();
    const h = renderWithFilePane(null, { onReveal });
    clickLink("workspace", "outputs/a.md");
    expect(h.pane().state.tabs.map((t) => t.id)).toEqual([
      "workspace:outputs/a.md",
    ]);
    expect(h.pane().state.mode).toBe("preview");
    expect(onReveal).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(h.lastFileParam()).toBe("workspace:outputs/a.md")
    );
  });

  it("opens memory links as memory tabs", () => {
    const h = renderWithFilePane(null);
    clickLink("memory", "notes/x.md");
    expect(h.pane().activeTab?.source).toBe("memory");
  });

  it("opens the file named in the URL on load", () => {
    const onReveal = vi.fn();
    const h = renderWithFilePane(null, {
      searchParams: "?file=memory:notes/x.md",
      onReveal,
    });
    expect(h.pane().activeTab?.id).toBe("memory:notes/x.md");
    expect(onReveal).toHaveBeenCalled();
  });

  it("clears a file param it can't read", async () => {
    const h = renderWithFilePane(null, { searchParams: "?file=bogus" });
    await waitFor(() => expect(h.fileParam()).toBeNull());
    expect(h.pane().state.tabs).toEqual([]);
  });

  it("drops the file param when going back to the tree", async () => {
    const h = renderWithFilePane(null);
    clickLink("workspace", "a.md");
    act(() => h.pane().showTree());
    await waitFor(() => expect(h.lastFileParam()).toBeNull());
    expect(h.pane().state.tabs).toHaveLength(1);
  });

  it("closes agent-state tabs when the conversation changes", () => {
    const h = renderWithFilePane(null);
    act(() => h.pane().registerChat(bridge("t1", { "a.md": "x" })));
    act(() => h.pane().open({ source: "state", path: "a.md" }));
    act(() => h.pane().open({ source: "workspace", path: "b.md" }));
    act(() => h.pane().registerChat(bridge("t2")));
    expect(h.pane().state.tabs.map((t) => t.id)).toEqual(["workspace:b.md"]);
  });

  it("keeps agent-state tabs when a new chat gets its thread id", () => {
    const h = renderWithFilePane(null);
    act(() => h.pane().registerChat(bridge(null, { "a.md": "x" })));
    act(() => h.pane().open({ source: "state", path: "a.md" }));
    act(() => h.pane().registerChat(bridge("t1", { "a.md": "x" })));
    expect(h.pane().state.tabs).toHaveLength(1);
  });

  it("keeps the same bridge when nothing changed", () => {
    const h = renderWithFilePane(null);
    const setFiles = async () => {};
    act(() =>
      h.pane().registerChat({
        threadId: "t1",
        files: { a: "1" },
        setFiles,
        editDisabled: false,
      })
    );
    const first = h.pane().chat;
    act(() =>
      h.pane().registerChat({
        threadId: "t1",
        files: { a: "1" },
        setFiles,
        editDisabled: false,
      })
    );
    expect(h.pane().chat).toBe(first);
  });

  it("bumps the refresh tick and the tree revision", () => {
    const h = renderWithFilePane(null);
    act(() => h.pane().notifyFilesMayHaveChanged());
    act(() => h.pane().bumpTreeRevision());
    expect(h.pane().refreshTick).toBe(1);
    expect(h.pane().treeRevision).toBe(1);
  });

  it("forgets a closed tab's draft", () => {
    const h = renderWithFilePane(null);
    act(() => h.pane().open({ source: "workspace", path: "a.md" }));
    h.pane().drafts.set("workspace:a.md", { text: "draft", base: "" });
    act(() => h.pane().close("workspace:a.md"));
    expect(h.pane().drafts.get("workspace:a.md")).toBeUndefined();
  });
});
