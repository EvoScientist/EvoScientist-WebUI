// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { WorkspaceFileView } from "./WorkspaceFileView";
import { MAX_INLINE_TEXT_BYTES } from "@/lib/fileKinds";
import type { Draft, DraftStore } from "@/providers/filePaneContext";

let disk: Record<string, string>;
let failNextRead: string | null;
let putGate: Promise<void> | null;

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/workspace") {
        const dir = url.searchParams.get("path") ?? "";
        const entries = Object.keys(disk)
          .filter(
            (p) =>
              (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === dir
          )
          .map((p) => ({ path: p, type: "file" }));
        return respond({ entries });
      }
      const path = url.searchParams.get("path")!;
      if (init?.method === "PUT") {
        if (putGate) await putGate;
        disk[path] = JSON.parse(String(init.body)).content;
        return respond({ path });
      }
      if (init?.method === "DELETE") {
        if (path === "locked.md") return respond({ error: "Nope." }, 500);
        delete disk[path];
        return respond({ ok: true });
      }
      if (failNextRead) {
        const message = failNextRead;
        failNextRead = null;
        return respond({ error: message }, 500);
      }
      if (path === "big.md") {
        return new Response("x", {
          headers: { "content-length": String(MAX_INLINE_TEXT_BYTES + 1) },
        });
      }
      if (!(path in disk)) {
        return respond({ error: "Path is not accessible." }, 400);
      }
      return new Response(disk[path], {
        headers: { "content-length": String(disk[path].length) },
      });
    })
  );
}

const reads = (path: string) =>
  vi
    .mocked(fetch)
    .mock.calls.filter(
      ([url, init]) =>
        String(url).startsWith("/api/workspace/file") &&
        String(url).includes(`path=${encodeURIComponent(path)}`) &&
        !(init as RequestInit | undefined)?.method
    ).length;

function draftStore(): DraftStore {
  const m = new Map<string, Draft>();
  return {
    get: (id) => m.get(id),
    set: (id, d) => {
      if (d === undefined) m.delete(id);
      else m.set(id, d);
    },
  };
}

type Props = React.ComponentProps<typeof WorkspaceFileView>;

function setup(over: Partial<Props> = {}) {
  const props: Props = {
    tabId: "workspace:a.md",
    path: "a.md",
    size: 10,
    visible: true,
    refreshTick: 0,
    drafts: draftStore(),
    onDirtyChange: vi.fn(),
    onClose: vi.fn(),
    onTreeChanged: vi.fn(),
    ...over,
  };
  const utils = render(<WorkspaceFileView {...props} />);
  const update = (p: Partial<Props>) =>
    utils.rerender(
      <WorkspaceFileView
        {...props}
        {...p}
      />
    );
  return { props, update, ...utils };
}

beforeEach(() => {
  disk = { "a.md": "first version" };
  failNextRead = null;
  putGate = null;
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("WorkspaceFileView", () => {
  it("shows the file", async () => {
    setup();
    expect(await screen.findByText("first version")).toBeTruthy();
  });

  it("shows the new version after the agent rewrites it", async () => {
    const { update } = setup();
    await screen.findByText("first version");
    disk["a.md"] = "second version";
    update({ refreshTick: 1 });
    expect(await screen.findByText("second version")).toBeTruthy();
  });

  it("holds a disk change back while there are unsaved edits", async () => {
    const { update } = setup();
    await screen.findByText("first version");
    fireEvent.click(screen.getByRole("button", { name: "Edit file" }));
    fireEvent.change(screen.getByLabelText("File content"), {
      target: { value: "my edit" },
    });
    disk["a.md"] = "agent version";
    update({ refreshTick: 1 });
    expect(await screen.findByText("The file changed on disk.")).toBeTruthy();
    expect(
      (screen.getByLabelText("File content") as HTMLTextAreaElement).value
    ).toBe("my edit");

    fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    expect(screen.queryByText("The file changed on disk.")).toBeNull();
    expect(
      (screen.getByLabelText("File content") as HTMLTextAreaElement).value
    ).toBe("my edit");
  });

  it("reloads the disk version on request, dropping the edits", async () => {
    const { update } = setup();
    await screen.findByText("first version");
    fireEvent.click(screen.getByRole("button", { name: "Edit file" }));
    fireEvent.change(screen.getByLabelText("File content"), {
      target: { value: "my edit" },
    });
    disk["a.md"] = "agent version";
    update({ refreshTick: 1 });
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(await screen.findByText("agent version")).toBeTruthy();
    expect(screen.queryByLabelText("File content")).toBeNull();
  });

  it("says when the file is gone, and closes the tab on request", async () => {
    const { update, props } = setup();
    await screen.findByText("first version");
    delete disk["a.md"];
    update({ refreshTick: 1 });
    expect(await screen.findByText("This file no longer exists.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(props.onClose).toHaveBeenCalledWith("workspace:a.md");
  });

  it("keeps the last content when a refresh fails", async () => {
    const { update } = setup();
    await screen.findByText("first version");
    failNextRead = "Backend unavailable";
    update({ refreshTick: 1 });
    expect(await screen.findByText("Backend unavailable")).toBeTruthy();
    expect(screen.getByText("first version")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByText("Backend unavailable")).toBeNull()
    );
  });

  it("re-reads a hidden tab once, when it is shown", async () => {
    const { update } = setup();
    await screen.findByText("first version");
    update({ visible: false, refreshTick: 1 });
    update({ visible: false, refreshTick: 2 });
    expect(reads("a.md")).toBe(1);
    disk["a.md"] = "newer";
    update({ visible: true, refreshTick: 2 });
    expect(await screen.findByText("newer")).toBeTruthy();
    expect(reads("a.md")).toBe(2);
  });

  it("ignores a slower, older read", async () => {
    const { update } = setup();
    await screen.findByText("first version");
    const fetchMock = vi.mocked(fetch);
    const real = fetchMock.getMockImplementation()!;
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementationOnce(async (...args) => {
      const res = await real(...args);
      await slow;
      return res;
    });
    disk["a.md"] = "v2";
    update({ refreshTick: 1 });
    disk["a.md"] = "v3";
    update({ refreshTick: 2 });
    expect(await screen.findByText("v3")).toBeTruthy();
    await act(async () => {
      release();
      await slow;
    });
    expect(screen.queryByText("v2")).toBeNull();
    expect(screen.getByText("v3")).toBeTruthy();
  });

  it("stops at the size cap when the opener didn't know the size", async () => {
    const { update } = setup({
      tabId: "workspace:big.md",
      path: "big.md",
      size: undefined,
    });
    expect(
      await screen.findByText("This file is too large to preview inline.")
    ).toBeTruthy();
    update({ refreshTick: 1 });
    update({ refreshTick: 2 });
    expect(reads("big.md")).toBe(1);
  });

  it("doesn't let a refresh during a save undo or flag it", async () => {
    const { update, props } = setup();
    await screen.findByText("first version");
    fireEvent.click(screen.getByRole("button", { name: "Edit file" }));
    fireEvent.change(screen.getByLabelText("File content"), {
      target: { value: "saved text" },
    });
    let releasePut!: () => void;
    putGate = new Promise<void>((r) => (releasePut = r));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // A read started mid-save would see the old file and answer late.
    const fetchMock = vi.mocked(fetch);
    const real = fetchMock.getMockImplementation()!;
    let releaseRead!: () => void;
    const slowRead = new Promise<void>((r) => (releaseRead = r));
    fetchMock.mockImplementationOnce(async (...args) => {
      const res = await real(...args);
      await slowRead;
      return res;
    });
    update({ refreshTick: 1 });
    await act(async () => {
      releasePut();
      await putGate;
    });
    expect(await screen.findByText("saved text")).toBeTruthy();
    await act(async () => {
      releaseRead();
      await slowRead;
    });
    expect(screen.getByText("saved text")).toBeTruthy();
    expect(screen.queryByText("first version")).toBeNull();
    expect(screen.queryByText("The file changed on disk.")).toBeNull();
    expect(props.onTreeChanged).toHaveBeenCalled();
    expect(disk["a.md"]).toBe("saved text");
  });

  it("doesn't let a read started before a save undo it", async () => {
    const { update } = setup();
    await screen.findByText("first version");
    fireEvent.click(screen.getByRole("button", { name: "Edit file" }));
    // The agent's turn ends just before Save: its read sees the old file.
    const fetchMock = vi.mocked(fetch);
    const real = fetchMock.getMockImplementation()!;
    let releaseRead!: () => void;
    const slowRead = new Promise<void>((r) => (releaseRead = r));
    fetchMock.mockImplementationOnce(async (...args) => {
      const res = await real(...args);
      await slowRead;
      return res;
    });
    update({ refreshTick: 1 });
    fireEvent.change(screen.getByLabelText("File content"), {
      target: { value: "saved text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("saved text")).toBeTruthy();
    await act(async () => {
      releaseRead();
      await slowRead;
    });
    expect(screen.getByText("saved text")).toBeTruthy();
    expect(screen.queryByText("first version")).toBeNull();
  });

  it("reports unsaved edits and keeps them across a remount", async () => {
    const drafts = draftStore();
    const first = setup({ drafts });
    await screen.findByText("first version");
    fireEvent.click(screen.getByRole("button", { name: "Edit file" }));
    fireEvent.change(screen.getByLabelText("File content"), {
      target: { value: "draft text" },
    });
    await waitFor(() =>
      expect(first.props.onDirtyChange).toHaveBeenLastCalledWith(
        "workspace:a.md",
        true
      )
    );
    first.unmount();
    setup({ drafts });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("File content") as HTMLTextAreaElement).value
      ).toBe("draft text")
    );
  });

  it("flags a disk change made while its draft was unmounted", async () => {
    // The inspector was closed with unsaved edits, then the agent rewrote
    // the file: reopening must not adopt the new text silently.
    const drafts = draftStore();
    drafts.set("workspace:a.md", { text: "my draft", base: "first version" });
    disk["a.md"] = "agent version";
    const { props } = setup({ drafts });
    expect(await screen.findByText("The file changed on disk.")).toBeTruthy();
    expect(
      (screen.getByLabelText("File content") as HTMLTextAreaElement).value
    ).toBe("my draft");
    // Reported dirty from the start, never clean while the read is out.
    expect(vi.mocked(props.onDirtyChange).mock.calls[0]).toEqual([
      "workspace:a.md",
      true,
    ]);
  });

  it("deletes after confirmation and closes the tab", async () => {
    const { props } = setup();
    await screen.findByText("first version");
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(props.onClose).toHaveBeenCalledWith("workspace:a.md")
    );
    expect(props.onTreeChanged).toHaveBeenCalled();
    expect(disk["a.md"]).toBeUndefined();
  });

  it("keeps the tab and shows why when a delete fails", async () => {
    disk["locked.md"] = "keep me";
    const { props } = setup({
      tabId: "workspace:locked.md",
      path: "locked.md",
    });
    await screen.findByText("keep me");
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Nope.")).toBeTruthy();
    expect(screen.queryByText("Delete file?")).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("re-shows an image on refresh but a PDF only on request", async () => {
    disk["fig.png"] = "";
    disk["doc.pdf"] = "";
    const img = setup({ tabId: "workspace:fig.png", path: "fig.png" });
    const imgEl = () => screen.getByAltText("fig.png") as HTMLImageElement;
    expect(imgEl().src).not.toContain("v=");
    img.update({ refreshTick: 1 });
    await waitFor(() => expect(imgEl().src).toContain("v=1"));
    img.unmount();

    const pdf = setup({ tabId: "workspace:doc.pdf", path: "doc.pdf" });
    const frame = () => pdf.container.querySelector("iframe")!;
    pdf.update({ refreshTick: 1 });
    expect(frame().src).not.toContain("v=");
    fireEvent.click(screen.getByRole("button", { name: "Reload file" }));
    await waitFor(() => expect(frame().src).toContain("v=1"));
  });

  it("recovers an image that failed to load while it still exists", async () => {
    // e.g. the agent was rewriting the figure, or the backend restarted.
    disk["fig.png"] = "";
    const { update } = setup({ tabId: "workspace:fig.png", path: "fig.png" });
    fireEvent.error(screen.getByAltText("fig.png"));
    expect(await screen.findByText("Failed to load image.")).toBeTruthy();
    expect(screen.queryByText("This file no longer exists.")).toBeNull();
    // The agent's next write brings it back without a click.
    update({ refreshTick: 1 });
    const img = (await screen.findByAltText("fig.png")) as HTMLImageElement;
    expect(img.src).toContain("v=1");
  });

  it("says an image is gone only when the folder no longer lists it", async () => {
    setup({ tabId: "workspace:fig.png", path: "fig.png" });
    fireEvent.error(screen.getByAltText("fig.png"));
    expect(await screen.findByText("This file no longer exists.")).toBeTruthy();
  });
});
