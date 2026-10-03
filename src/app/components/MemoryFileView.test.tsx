// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryFileView } from "./MemoryFileView";

let memory: Record<string, string>;
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => {
  memory = { "notes/a.md": "remembered" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.searchParams.get("path");
      if (path === null) {
        return respond({
          entries: Object.keys(memory).map((p) => ({ path: p })),
          truncated: false,
        });
      }
      if (!(path in memory)) return respond({ error: "ENOENT" }, 400);
      return respond({ path, content: memory[path] });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

type Props = React.ComponentProps<typeof MemoryFileView>;

const view = (over: Partial<Props> = {}) => {
  const props: Props = {
    tabId: "memory:notes/a.md",
    path: "notes/a.md",
    visible: true,
    refreshTick: 0,
    onClose: vi.fn(),
    ...over,
  };
  const utils = render(<MemoryFileView {...props} />);
  return {
    props,
    update: (p: Partial<Props>) =>
      utils.rerender(
        <MemoryFileView
          {...props}
          {...p}
        />
      ),
  };
};

describe("MemoryFileView", () => {
  it("shows the memory file read-only", async () => {
    view();
    expect(await screen.findByText("remembered")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit file" })).toBeNull();
  });

  it("follows a rewrite by the memory worker", async () => {
    const { update } = view();
    await screen.findByText("remembered");
    memory["notes/a.md"] = "updated";
    update({ refreshTick: 1 });
    expect(await screen.findByText("updated")).toBeTruthy();
  });

  it("says when the file is gone", async () => {
    const { update, props } = view();
    await screen.findByText("remembered");
    delete memory["notes/a.md"];
    update({ refreshTick: 1 });
    expect(await screen.findByText("This file no longer exists.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(props.onClose).toHaveBeenCalledWith("memory:notes/a.md");
  });
});
