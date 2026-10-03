// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { WorkspacePanel } from "./WorkspacePanel";
import { renderWithFilePane } from "@/test/filePaneHarness";

const listings = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([url]) =>
      String(url).startsWith("/api/workspace?path=")
    ).length;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            entries: [
              {
                name: "a.md",
                path: "a.md",
                type: "file",
                size: 3,
                mtime: 0,
                ext: "md",
              },
            ],
          })
        )
    )
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("WorkspacePanel", () => {
  it("opens a file in the pane, marks it, and offers the way back", async () => {
    const h = renderWithFilePane(<WorkspacePanel />);
    fireEvent.click(await screen.findByRole("button", { name: /a\.md/ }));
    expect(h.pane().activeTab).toMatchObject({
      id: "workspace:a.md",
      size: 3,
    });
    expect(screen.getByLabelText("Open in preview")).toBeTruthy();

    act(() => h.pane().showTree());
    fireEvent.click(
      screen.getByRole("button", { name: "Back to preview (1 open)" })
    );
    expect(h.pane().state.mode).toBe("preview");
  });

  it("re-lists after the pane saved or deleted a file", async () => {
    const h = renderWithFilePane(<WorkspacePanel />);
    await screen.findByRole("button", { name: /a\.md/ });
    const before = listings();
    act(() => h.pane().bumpTreeRevision());
    await waitFor(() => expect(listings()).toBeGreaterThan(before));
  });
});
