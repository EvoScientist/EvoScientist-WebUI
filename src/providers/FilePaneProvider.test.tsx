// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { toast } from "sonner";
import { dispatchFileLink, FILE_LINK_EVENT } from "@/lib/fileLink";
import {
  onScreen,
  renderWithFilePane,
  resetScreen,
} from "@/test/filePaneHarness";
import type { ChatFilesBridge } from "./filePaneContext";

const bridge = (
  threadId: string | null,
  files: Record<string, string> = {}
): ChatFilesBridge => ({
  threadId,
  files,
  setFiles: async () => {},
  editDisabled: false,
  project: null,
});

const clickLink = (kind: "workspace" | "memory", path: string) =>
  act(() => {
    window.dispatchEvent(
      new CustomEvent(FILE_LINK_EVENT, {
        detail: { kind, display: path, path },
      })
    );
  });

const fileLink = (path: string) => ({
  kind: "workspace" as const,
  display: path,
  path,
});

afterEach(resetScreen);

const PROJECT_B = "d36e3f1a-02c5-5639-92a2-d1faaafb1ded";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

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

  it("opens a chat file link in the conversation's project", () => {
    const h = renderWithFilePane(null);
    act(() => h.pane().registerChat({ ...bridge("t1"), project: PROJECT_B }));
    clickLink("workspace", "outputs/a.md");
    expect(h.pane().activeTab).toMatchObject({
      path: "outputs/a.md",
      project: PROJECT_B,
    });
  });

  it("opens a link in the project the conversation moved to", () => {
    const h = renderWithFilePane(null);
    const before = bridge("t1");
    act(() => h.pane().registerChat(before));
    act(() => h.pane().registerChat({ ...before, project: PROJECT_B }));

    clickLink("workspace", "outputs/a.md");

    expect(h.pane().activeTab).toMatchObject({ project: PROJECT_B });
  });

  it("opens nothing for a conversation whose project files can't be shown", () => {
    const h = renderWithFilePane(null);
    act(() => h.pane().registerChat(bridge("t1")));
    clickLink("workspace", "outputs/a.md");
    expect(h.pane().state.tabs).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("can't be shown here")
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
        project: null,
      })
    );
    const first = h.pane().chat;
    act(() =>
      h.pane().registerChat({
        threadId: "t1",
        files: { a: "1" },
        setFiles,
        editDisabled: false,
        project: null,
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

  it("hands out a focus request once", () => {
    const h = renderWithFilePane(null);
    expect(h.pane().takeFocusRequest()).toBe(false);
    act(() => h.pane().requestFocus());
    expect(h.pane().takeFocusRequest()).toBe(true);
    expect(h.pane().takeFocusRequest()).toBe(false);
  });

  it("writes the file param only while the inspector is open", async () => {
    const h = renderWithFilePane(null);
    act(() => h.pane().open({ source: "workspace", path: "a.md" }));
    await waitFor(() => expect(h.fileParam()).toBe("workspace:a.md"));

    h.setInspectorOpen(false);
    await waitFor(() => expect(h.fileParam()).toBeNull());
    // The pane keeps the file for when the inspector opens again.
    expect(h.pane().state.mode).toBe("preview");
    expect(h.pane().state.tabs).toHaveLength(1);

    h.setInspectorOpen(true);
    await waitFor(() => expect(h.fileParam()).toBe("workspace:a.md"));
  });

  it.each([
    ["inline code", "./a.md"],
    ["a bare path", "/a.md"],
  ])(
    "hands focus back to the chat link (%s) that opened the file",
    (_, name) => {
      const h = renderWithFilePane(
        <>
          <textarea aria-label="Message" />
          <MarkdownContent content="Saved to `./a.md`, a copy at /a.md." />
        </>
      );
      const link = screen.getByRole("button", { name });
      onScreen(link);
      act(() => screen.getByRole("textbox", { name: "Message" }).focus());
      // A click that doesn't focus the link, as in Safari.
      fireEvent.click(link);
      expect(h.pane().state.activeId).toBe("workspace:a.md");
      // Focus went into the inspector, which then closed with it.
      act(() => (document.activeElement as HTMLElement).blur());
      const focus = vi.spyOn(link, "focus");

      h.setInspectorOpen(false);
      expect(document.activeElement).toBe(link);
      // Without scrolling the chat back to the link.
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    }
  );

  it("leaves focus where the user put it", () => {
    const h = renderWithFilePane(
      <>
        <button type="button">a.md</button>
        <button type="button">Elsewhere</button>
      </>
    );
    const link = screen.getByRole("button", { name: "a.md" });
    onScreen(link);
    act(() => dispatchFileLink(fileLink("a.md"), link));
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());

    h.setInspectorOpen(false);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Elsewhere" })
    );
  });

  it("keeps the opener from before files opened inside the inspector", () => {
    const h = renderWithFilePane(
      <>
        <button type="button">a.md</button>
        <div data-file-pane="tree">
          <button type="button">b.md</button>
        </div>
      </>
    );
    const link = screen.getByRole("button", { name: "a.md" });
    onScreen(link);
    act(() => dispatchFileLink(fileLink("a.md"), link));
    // A link in the inspector (an agent's output), then a tree row.
    act(() =>
      dispatchFileLink(
        fileLink("b.md"),
        screen.getByRole("button", { name: "b.md" })
      )
    );
    act(() => h.pane().open({ source: "workspace", path: "c.md" }));

    h.setInspectorOpen(false);
    expect(document.activeElement).toBe(link);
  });

  it("gives focus back once per link", () => {
    const h = renderWithFilePane(<button type="button">a.md</button>);
    const link = screen.getByRole("button", { name: "a.md" });
    onScreen(link);
    act(() => dispatchFileLink(fileLink("a.md"), link));
    h.setInspectorOpen(false);
    expect(document.activeElement).toBe(link);

    // Opened again from the header, not from the link.
    h.setInspectorOpen(true);
    act(() => link.blur());
    h.setInspectorOpen(false);
    expect(document.activeElement).toBe(document.body);
  });

  describe("when the link can't take focus", () => {
    const setup = () => {
      const toggle = createRef<HTMLButtonElement>();
      const h = renderWithFilePane(
        <>
          <button
            type="button"
            ref={toggle}
          >
            Show workspace
          </button>
          <button type="button">a.md</button>
        </>,
        { inspectorToggleRef: toggle }
      );
      return {
        h,
        toggle: screen.getByRole("button", { name: "Show workspace" }),
        link: screen.getByRole("button", { name: "a.md" }),
      };
    };

    it("hands focus to the inspector toggle when the link is off screen", () => {
      // Scrolled away, or in a view the user switched away from.
      const { h, toggle, link } = setup();
      onScreen(toggle);
      act(() => dispatchFileLink(fileLink("a.md"), link));

      h.setInspectorOpen(false);
      expect(document.activeElement).toBe(toggle);
    });

    it("hands focus to the inspector toggle when something covers the link", () => {
      const { h, toggle, link } = setup();
      onScreen(toggle, link);
      // A toast, say, over the link's centre.
      const toast = document.createElement("div");
      document.body.append(toast);
      const hitTest = document.elementFromPoint.bind(document);
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: (x: number, y: number) => {
          const hit = hitTest(x, y);
          return hit === link ? toast : hit;
        },
      });
      act(() => dispatchFileLink(fileLink("a.md"), link));

      h.setInspectorOpen(false);
      expect(document.activeElement).toBe(toggle);
      toast.remove();
    });

    it("hands focus to the inspector toggle when no link opened the file", () => {
      const { h, toggle } = setup();
      onScreen(toggle);
      act(() => h.pane().open({ source: "workspace", path: "a.md" }));

      h.setInspectorOpen(false);
      expect(document.activeElement).toBe(toggle);
    });

    it("leaves focus alone when neither the link nor the toggle is on screen", () => {
      const { h, link } = setup();
      act(() => dispatchFileLink(fileLink("a.md"), link));

      h.setInspectorOpen(false);
      expect(document.activeElement).toBe(document.body);
    });

    it("leaves focus alone when another drawer takes the inspector's place", () => {
      // The phone sidebar opening closes the inspector.
      const { h, toggle, link } = setup();
      onScreen(toggle, link);
      act(() => dispatchFileLink(fileLink("a.md"), link));

      h.setInspectorOpen(false, { returnFocusOnClose: false });
      expect(document.activeElement).toBe(document.body);
    });
  });

  it("opens an old link's file without the inspector open", async () => {
    // Links from before the param followed the inspector: file= without
    // inspector=. The inspector opens for them (onReveal).
    const onReveal = vi.fn();
    const h = renderWithFilePane(null, {
      searchParams: "?file=workspace:a.md",
      inspectorOpen: false,
      onReveal,
    });
    expect(h.pane().state.activeId).toBe("workspace:a.md");
    expect(onReveal).toHaveBeenCalled();
    expect(h.fileParam()).toBe("workspace:a.md");

    h.setInspectorOpen(true);
    await waitFor(() => expect(h.fileParam()).toBe("workspace:a.md"));
    expect(h.pane().state.mode).toBe("preview");
  });
});
