// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceFileDialog } from "./WorkspaceFileDialog";

// The dialog stays mounted while closed (`path === null` renders nothing), so
// anything it keeps in state outlives the file it was opened for.
describe("WorkspaceFileDialog", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "DELETE"
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response("file body", { status: 200 })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not carry the delete confirmation over to the next file", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <WorkspaceFileDialog
        path="a.txt"
        size={9}
        onClose={onClose}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Delete file" }));
    expect(await screen.findByText("Delete file?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    // The parent clears the selection, then the user opens another file.
    rerender(
      <WorkspaceFileDialog
        path={null}
        onClose={onClose}
      />
    );
    rerender(
      <WorkspaceFileDialog
        path="b.txt"
        size={9}
        onClose={onClose}
      />
    );

    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([url]) => String(url).includes("b.txt"))
      ).toBe(true)
    );
    expect(screen.queryByText("Delete file?")).toBeNull();
  });

  it("does not carry an open delete confirmation over when the file is switched", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <WorkspaceFileDialog
        path="a.txt"
        size={9}
        onClose={onClose}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete file" }));
    expect(await screen.findByText("Delete file?")).toBeTruthy();

    // A file link clicked in the chat swaps the path without closing first.
    rerender(
      <WorkspaceFileDialog
        path="b.txt"
        size={9}
        onClose={onClose}
      />
    );

    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([url]) => String(url).includes("b.txt"))
      ).toBe(true)
    );
    expect(screen.queryByText("Delete file?")).toBeNull();
  });
});
