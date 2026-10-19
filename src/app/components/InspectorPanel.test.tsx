// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import {
  onScreen,
  renderWithFilePane,
  resetScreen,
} from "@/test/filePaneHarness";

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
// The backend the page talks to; a test can move it to another one.
const deployment = vi.hoisted(() => ({
  deploymentUrl: "http://127.0.0.1:6174",
  apiKey: "",
}));
vi.mock("@/providers/ClientProvider", () => ({
  useDeployment: () => ({ ...deployment }),
}));
const agentsMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/app/components/AgentsPanel", async () => {
  const { useEffect } = await import("react");
  return {
    AgentsPanel: () => {
      useEffect(() => {
        agentsMounts.count += 1;
      }, []);
      return <div>agents</div>;
    },
  };
});
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

  it("starts the Agents panel over on another backend", () => {
    const rerender = { current: () => {} };
    function Host() {
      const [, setTick] = useState(0);
      rerender.current = () => setTick((n) => n + 1);
      return <InspectorPanel onClose={() => {}} />;
    }
    renderWithFilePane(<Host />);
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    const mounts = agentsMounts.count;

    deployment.deploymentUrl = "http://127.0.0.1:7000";
    act(() => rerender.current());

    expect(agentsMounts.count).toBe(mounts + 1);
    deployment.deploymentUrl = "http://127.0.0.1:6174";
  });

  describe("focus", () => {
    afterEach(resetScreen);

    it("goes from a chat link to the file's tab and back when it closes", () => {
      const h = renderWithFilePane((open) => (
        <>
          <MarkdownContent content="Saved to `./a.md`." />
          {open && <InspectorPanel onClose={() => {}} />}
        </>
      ));
      const link = screen.getByRole("button", { name: "./a.md" });
      onScreen(link);
      act(() => link.focus());
      fireEvent.click(link);
      expect(focused()).toBe("workspace:a.md");

      h.setInspectorOpen(false);
      expect(screen.queryByText("preview")).toBeNull();
      expect(document.activeElement).toBe(link);
    });

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

    it("takes a focus request to the side that is shown", () => {
      const h = renderWithFilePane(
        <>
          <button>elsewhere</button>
          <InspectorPanel onClose={() => {}} />
        </>
      );
      act(() => h.pane().open({ source: "workspace", path: "a.md" }));
      act(() => screen.getByText("elsewhere").focus());
      act(() => h.pane().requestFocus());
      expect(focused()).toBe("workspace:a.md");

      act(() => h.pane().close("workspace:a.md"));
      act(() => screen.getByText("elsewhere").focus());
      act(() => h.pane().requestFocus());
      expect(focused()).toBe("Back to preview");
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
