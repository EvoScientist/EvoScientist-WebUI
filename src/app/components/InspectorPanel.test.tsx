// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithFilePane } from "@/test/filePaneHarness";

vi.mock("@/app/components/WorkspacePanel", async () => {
  const { useFilePane } = await import("@/providers/filePaneContext");
  return {
    WorkspacePanel: () => {
      const pane = useFilePane()!;
      return (
        <div>
          <span>tree</span>
          <button onClick={() => pane.showPreview()}>Back to preview</button>
          <button
            onClick={() => pane.open({ source: "workspace", path: "b.md" })}
          >
            b.md
          </button>
        </div>
      );
    },
  };
});
vi.mock("@/app/components/AgentsPanel", () => ({
  AgentsPanel: () => <div>agents</div>,
}));
vi.mock("@/app/components/FilePreviewPane", async () => {
  const { useFilePane } = await import("@/providers/filePaneContext");
  return {
    FilePreviewPane: () => {
      const pane = useFilePane()!;
      return (
        <div>
          <span>preview</span>
          <button onClick={() => pane.showTree()}>Back to files</button>
          {pane.state.tabs.map((t) => (
            <span key={t.id}>
              <button
                role="tab"
                aria-selected={t.id === pane.state.activeId}
              >
                {t.id}
              </button>
              <button
                onClick={() => pane.close(t.id)}
              >{`Close ${t.id}`}</button>
            </span>
          ))}
        </div>
      );
    },
  };
});

import { InspectorPanel } from "./InspectorPanel";

const isHidden = (text: string) =>
  screen.getByText(text).closest(".hidden") !== null;
const paneMode = (text: string) =>
  screen
    .getByText(text)
    .closest("[data-file-pane]")
    ?.getAttribute("data-file-pane");
const focused = () => document.activeElement?.textContent ?? null;

describe("InspectorPanel", () => {
  it("swaps the tree for the preview and keeps both mounted", () => {
    const h = renderWithFilePane(<InspectorPanel onClose={() => {}} />);
    expect(isHidden("tree")).toBe(false);
    expect(screen.queryByText("preview")).toBeNull();

    act(() => h.pane().open({ source: "workspace", path: "a.md" }));
    expect(isHidden("tree")).toBe(true);
    expect(isHidden("preview")).toBe(false);
    expect(paneMode("preview")).toBe("preview");

    act(() => h.pane().showTree());
    expect(isHidden("tree")).toBe(false);
    expect(isHidden("preview")).toBe(true);
  });

  it("hides the workspace side behind the Agents tab", () => {
    const h = renderWithFilePane(<InspectorPanel onClose={() => {}} />);
    act(() => h.pane().open({ source: "workspace", path: "a.md" }));
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    expect(screen.getByText("agents")).toBeTruthy();
    expect(isHidden("tree")).toBe(true);
    expect(isHidden("preview")).toBe(true);
    expect(paneMode("agents")).toBe("tree");
  });

  describe("focus", () => {
    it("moves to the file's tab when a link opens it", () => {
      const h = renderWithFilePane(
        <>
          <button>chat link</button>
          <InspectorPanel onClose={() => {}} />
        </>
      );
      screen.getByText("chat link").focus();
      act(() => h.pane().open({ source: "workspace", path: "a.md" }));
      expect(focused()).toBe("workspace:a.md");
    });

    it("moves into an inspector that opens with the file (phone)", () => {
      const revealRef = { current: () => {} };
      function Host() {
        const [shown, setShown] = useState(false);
        revealRef.current = () => setShown(true);
        return shown ? <InspectorPanel onClose={() => {}} /> : null;
      }
      const h = renderWithFilePane(<Host />, {
        onReveal: () => revealRef.current(),
      });
      act(() => h.pane().open({ source: "workspace", path: "a.md" }));
      expect(focused()).toBe("workspace:a.md");
    });

    it("isn't taken by a file opened from the URL", () => {
      renderWithFilePane(<InspectorPanel onClose={() => {}} />, {
        searchParams: "?file=workspace:a.md",
      });
      expect(isHidden("preview")).toBe(false);
      expect(document.activeElement).toBe(document.body);
    });

    it("follows to the side that is shown when its control hides", () => {
      renderWithFilePane(<InspectorPanel onClose={() => {}} />);
      const b = screen.getByText("b.md");
      b.focus();
      fireEvent.click(b);
      expect(focused()).toBe("workspace:b.md");

      const back = screen.getByText("Back to files");
      back.focus();
      fireEvent.click(back);
      expect(focused()).toBe("Back to preview");

      const forward = screen.getByText("Back to preview");
      forward.focus();
      fireEvent.click(forward);
      expect(focused()).toBe("workspace:b.md");
    });

    it("lands on the next tab when the focused close button goes", () => {
      const h = renderWithFilePane(<InspectorPanel onClose={() => {}} />);
      act(() => h.pane().open({ source: "workspace", path: "a.md" }));
      act(() => h.pane().open({ source: "workspace", path: "b.md" }));
      const close = screen.getByText("Close workspace:b.md");
      close.focus();
      fireEvent.click(close);
      expect(focused()).toBe("workspace:a.md");
    });

    it("follows when a click that doesn't take focus hides the tab", () => {
      // Safari doesn't focus a clicked button: the tab focused for the
      // opened file still has focus when "Back to files" hides it.
      // Nor does a browser window without focus report the focus moves the
      // inspector makes itself: keep those from React here.
      const h = renderWithFilePane(<InspectorPanel onClose={() => {}} />);
      const swallow = (e: Event) => e.stopPropagation();
      document.addEventListener("focusin", swallow, true);
      try {
        act(() => h.pane().open({ source: "workspace", path: "a.md" }));
      } finally {
        document.removeEventListener("focusin", swallow, true);
      }
      expect(focused()).toBe("workspace:a.md");
      fireEvent.click(screen.getByText("Back to files"));
      expect(focused()).toBe("Back to preview");
    });

    it("stays put when a tab is picked by clicking it", () => {
      const h = renderWithFilePane(<InspectorPanel onClose={() => {}} />);
      act(() => h.pane().open({ source: "workspace", path: "a.md" }));
      act(() => h.pane().open({ source: "workspace", path: "b.md" }));
      const tab = screen.getByText("workspace:a.md");
      tab.focus();
      act(() => h.pane().activate("workspace:a.md"));
      expect(document.activeElement).toBe(tab);
    });
  });
});
