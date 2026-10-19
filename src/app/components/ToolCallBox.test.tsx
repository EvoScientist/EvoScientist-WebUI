// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolCallBox } from "./ToolCallBox";
import type { ToolCall } from "@/app/types/types";
import { fileEditDiff } from "@/lib/fileEditDiff";

// The real diff, counted: it should run once per change, not once per render.
vi.mock("@/lib/fileEditDiff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fileEditDiff")>();
  return { ...actual, fileEditDiff: vi.fn(actual.fileEditDiff) };
});

const toolCall: ToolCall = {
  id: "tc1",
  name: "execute",
  args: { command: "ls" },
  status: "interrupted",
};
const actionRequest = { name: "execute", args: { command: "ls" } };
const noop = () => {};
const approvalCard = () =>
  screen.queryByRole("region", { name: /^Approval required/ });

describe("ToolCallBox approval expansion", () => {
  it("opens the approval card for a request that needs a human", () => {
    render(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        approvalAutoResolves={false}
      />
    );
    expect(approvalCard()).not.toBeNull();
  });

  it("keeps the card closed while the interrupt resolves without the user", () => {
    render(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        approvalAutoResolves={true}
      />
    );
    expect(approvalCard()).toBeNull();
  });

  it("stays openable by hand while auto-resolving, so a swallowed resume cannot lock the user out", () => {
    render(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        approvalAutoResolves={true}
      />
    );
    expect(approvalCard()).toBeNull();
    // The header is the only button while the box is collapsed.
    fireEvent.click(screen.getByRole("button"));
    expect(approvalCard()).not.toBeNull();
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  it("opens once the deployment hands the decision back to the user", () => {
    // The request is already on screen while the policy is being checked; the
    // card has to open when the answer is "a human must decide", not only at
    // the moment the request first appears.
    const { rerender } = render(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        approvalAutoResolves={true}
      />
    );
    expect(approvalCard()).toBeNull();
    rerender(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        approvalAutoResolves={false}
      />
    );
    expect(approvalCard()).not.toBeNull();
  });

  it("falls back to the local auto-approve policy when no verdict is passed", () => {
    const { unmount } = render(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        autoApprove={true}
      />
    );
    expect(approvalCard()).toBeNull();
    unmount();
    render(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        autoApprove={false}
      />
    );
    expect(approvalCard()).not.toBeNull();
  });
});

describe("ToolCallBox status icon", () => {
  it("spins while a result can still arrive", () => {
    const { container } = render(
      <ToolCallBox toolCall={{ ...toolCall, status: "pending" }} />
    );
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("stops spinning, and says so, once the run is over without a result", () => {
    const { container } = render(
      <ToolCallBox toolCall={{ ...toolCall, status: "stopped" }} />
    );
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.getByLabelText("Did not finish")).toBeTruthy();
  });
});

// deepagents' edit_file / write_file calls show their change as a line diff:
// counts on the collapsed row, the diff in place of the text args.
describe("ToolCallBox file edits", () => {
  const editCall = (args: unknown): ToolCall => ({
    id: "tc-edit",
    name: "edit_file",
    args: args as Record<string, unknown>,
    status: "completed",
    result:
      "Successfully replaced 1 instance(s) of the string in '/ws/train.py'",
  });
  const writeCall = (content: string): ToolCall => ({
    id: "tc-write",
    name: "write_file",
    args: { file_path: "/ws/notes.md", content },
    status: "completed",
    result: "Updated file /ws/notes.md",
  });
  const header = () => screen.getAllByRole("button")[0];
  const diffList = () => screen.getByRole("list", { name: "Changes" });
  const diffRows = () => [...diffList().querySelectorAll(":scope > li")];
  // What a row shows, and what a screen reader reads out.
  const without = (row: Element, selector: string) => {
    const copy = row.cloneNode(true) as Element;
    copy.querySelectorAll(selector).forEach((node) => node.remove());
    return copy.textContent;
  };
  const shown = (row: Element) => without(row, ".sr-only");
  const spoken = (row: Element) => without(row, '[aria-hidden="true"]');

  it("counts the added and removed lines on the collapsed row", () => {
    render(
      <ToolCallBox
        toolCall={editCall({
          file_path: "/ws/train.py",
          old_string: "epochs = 10",
          new_string: "epochs = 50\nwarmup = 5",
        })}
      />
    );

    expect(header().textContent).toContain("+2");
    expect(header().textContent).toContain("−1");
    expect(
      screen.getByRole("button", {
        name: /edit_file.*2 lines added, 1 line removed/,
      })
    ).toBe(header());
  });

  it("shows the edit as a diff in place of its old and new text", () => {
    render(
      <ToolCallBox
        toolCall={editCall({
          file_path: "/ws/train.py",
          old_string: "lr = 0.01\nepochs = 10",
          new_string: "lr = 0.01\nepochs = 50",
          replace_all: false,
        })}
      />
    );
    fireEvent.click(header());

    expect(diffRows().map(shown)).toEqual([
      " lr = 0.01",
      "−epochs = 10",
      "+epochs = 50",
    ]);
    expect(diffRows().map(spoken)).toEqual([
      "lr = 0.01",
      "Removed: epochs = 10",
      "Added: epochs = 50",
    ]);
    expect(diffList().getAttribute("role")).toBe("list");
    expect(screen.getByText("file_path:")).toBeTruthy();
    expect(screen.getByText("replace_all:")).toBeTruthy();
    expect(screen.queryByText("old_string:")).toBeNull();
    expect(screen.queryByText("new_string:")).toBeNull();
  });

  it("colors added and removed rows", () => {
    render(
      <ToolCallBox
        toolCall={editCall({
          old_string: "a\nb",
          new_string: "a\nc",
        })}
      />
    );
    fireEvent.click(header());

    const [context, removed, added] = diffRows();
    expect(removed.className).toContain("bg-[var(--color-diff-removed-bg)]");
    expect(added.className).toContain("bg-[var(--color-diff-added-bg)]");
    expect(context.className).not.toMatch(/color-diff/);
  });

  it("shows a written file as added lines", () => {
    render(<ToolCallBox toolCall={writeCall("# Notes\nfirst\n")} />);

    expect(header().textContent).toContain("+2");
    expect(header().textContent).not.toContain("−");
    fireEvent.click(header());
    expect(diffRows().map(shown)).toEqual(["+# Notes", "+first"]);
    expect(screen.queryByText("content:")).toBeNull();
  });

  it("folds the middle of a long diff until asked", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
      "\n"
    );
    render(<ToolCallBox toolCall={writeCall(content)} />);
    fireEvent.click(header());

    expect(screen.queryByText("line 7")).toBeNull();
    expect(screen.getByText("line 20")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 9 more lines" }));
    expect(screen.getByText("line 7")).toBeTruthy();
    expect(diffRows()).toHaveLength(20);
    // The button is gone; focus stays in the diff instead of the page.
    expect(document.activeElement).toBe(diffList());
  });

  // One line of minified JSON or base64 would otherwise fill the screen.
  it("shows the start of a very long line until asked", () => {
    render(<ToolCallBox toolCall={writeCall("a".repeat(3000) + "\nend\n")} />);
    fireEvent.click(header());

    expect(shown(diffRows()[0])).toBe(
      "+" + "a".repeat(1000) + "Show 2,000 more characters"
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show 2,000 more characters" })
    );
    expect(shown(diffRows()[0])).toBe("+" + "a".repeat(3000));
    expect(document.activeElement).toBe(diffList());
  });

  it("marks the gap between far-apart changes for screen readers too", () => {
    const lines = "abcdefghij".split("");
    render(
      <ToolCallBox
        toolCall={editCall({
          old_string: lines.join("\n"),
          new_string: ["A", ...lines.slice(1, 9), "J"].join("\n"),
        })}
      />
    );
    fireEvent.click(header());

    const gap = diffRows()[5];
    expect(shown(gap)).toBe("⋯");
    expect(spoken(gap)).toBe("Unchanged lines skipped");
    expect(gap.className).toContain("select-none");
  });

  it("says when only whitespace at line ends changes", () => {
    render(
      <ToolCallBox
        toolCall={editCall({ old_string: "x = 1 ", new_string: "x = 1" })}
      />
    );
    fireEvent.click(header());

    expect(diffRows().map(shown)).toEqual([
      "−x = 1 ",
      "+x = 1",
      "Only line endings or trailing whitespace change",
    ]);
  });

  it("shows no counts when no whole line changes", () => {
    render(
      <ToolCallBox
        toolCall={editCall({ old_string: "x = 1\n", new_string: "x = 1" })}
      />
    );

    expect(header().textContent).not.toMatch(/[+−]\d/);
    expect(header().querySelector(".sr-only")).toBeNull();
    fireEvent.click(header());
    expect(diffRows().map(shown)).toEqual([
      " x = 1",
      "The old text ended with a line break; the new one doesn't",
    ]);
    expect(diffRows()[1].className).toContain("select-none");
  });

  // A copy of the rows gives the code alone.
  it("keeps signs, labels and buttons out of a selection", () => {
    const content = [
      "a".repeat(1500),
      ...Array.from({ length: 20 }, (_, i) => `line ${i}`),
    ].join("\n");
    render(<ToolCallBox toolCall={writeCall(content)} />);
    fireEvent.click(header());

    const extras = diffList().querySelectorAll(
      '.sr-only, button, [aria-hidden="true"]'
    );
    expect(extras.length).toBeGreaterThan(3);
    for (const node of extras) {
      expect(node.closest(".select-none")).not.toBeNull();
    }
  });

  // What was opened is kept by the line's place in the diff, not on screen.
  it("keeps a long line open after showing the folded lines", () => {
    const content = [
      ...Array.from({ length: 19 }, (_, i) => `line ${i + 1}`),
      "z".repeat(1500),
    ].join("\n");
    render(<ToolCallBox toolCall={writeCall(content)} />);
    fireEvent.click(header());
    fireEvent.click(
      screen.getByRole("button", { name: "Show 500 more characters" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Show 9 more lines" }));

    expect(shown(diffRows()[19])).toBe("+" + "z".repeat(1500));
    expect(
      screen.queryByRole("button", { name: /more characters/ })
    ).toBeNull();
  });

  it("keeps the folded lines shown after opening a long line", () => {
    const content = [
      ...Array.from({ length: 19 }, (_, i) => `line ${i + 1}`),
      "z".repeat(1500),
    ].join("\n");
    render(<ToolCallBox toolCall={writeCall(content)} />);
    fireEvent.click(header());
    fireEvent.click(screen.getByRole("button", { name: "Show 9 more lines" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Show 500 more characters" })
    );

    expect(diffRows()).toHaveLength(20);
    expect(shown(diffRows()[19])).toBe("+" + "z".repeat(1500));
  });

  // A box keeps its place when the same call shows up with other args (a
  // sub-agent's steps restored, then replaced by live ones).
  it("starts a new diff of the same call folded", () => {
    const lines = (word: string) =>
      Array.from({ length: 20 }, (_, i) => `${word} ${i}`);
    const { rerender } = render(
      <ToolCallBox
        toolCall={writeCall(["a".repeat(1500), ...lines("old")].join("\n"))}
      />
    );
    fireEvent.click(header());
    fireEvent.click(
      screen.getByRole("button", { name: "Show 500 more characters" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Show 10 more lines" }));

    rerender(
      <ToolCallBox
        toolCall={writeCall(["b".repeat(1500), ...lines("new")].join("\n"))}
      />
    );
    expect(diffRows()).toHaveLength(12);
    expect(
      screen.getByRole("button", { name: "Show 10 more lines" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Show 500 more characters" })
    ).toBeTruthy();
  });

  // replace_all applies the change at every match; the result says how many.
  it("counts a replace-all edit per match", () => {
    render(
      <ToolCallBox
        toolCall={editCall({
          old_string: "lr = 0.1",
          new_string: "lr = 0.01",
          replace_all: true,
        })}
      />
    );

    expect(header().textContent).toContain("per match");
    expect(
      screen.getByRole("button", {
        name: /1 line added, 1 line removed per match/,
      })
    ).toBe(header());
  });

  it("fits the diff to the compact sub-agent steps", () => {
    render(
      <ToolCallBox
        toolCall={editCall({ old_string: "a", new_string: "b" })}
        compact
      />
    );
    fireEvent.click(header());

    expect(diffList().className).toContain("text-[11px]");
  });

  it("works the diff out once per change, not on every render", () => {
    const args = { file_path: "/ws/a.py", old_string: "a", new_string: "b" };
    vi.mocked(fileEditDiff).mockClear();
    const { rerender } = render(<ToolCallBox toolCall={editCall(args)} />);
    // The chat rebuilds its tool calls as it streams.
    rerender(<ToolCallBox toolCall={editCall({ ...args })} />);

    expect(fileEditDiff).toHaveBeenCalledTimes(1);
  });

  // While streaming, args can still be a partial JSON string.
  it("shows no diff while the args are still streaming in", () => {
    render(
      <ToolCallBox
        toolCall={editCall('{"file_path": "/ws/train.py", "old_str')}
      />
    );

    expect(header().textContent).not.toMatch(/[+−]\d/);
    fireEvent.click(header());
    expect(screen.queryByRole("list", { name: "Changes" })).toBeNull();
  });

  it("shows the diff once the call has its result, not while it runs", () => {
    const args = {
      file_path: "/ws/train.py",
      old_string: "epochs = 10",
      new_string: "epochs = 50",
    };
    const { rerender } = render(
      <ToolCallBox toolCall={{ ...editCall(args), status: "pending" }} />
    );
    fireEvent.click(header());

    expect(screen.queryByRole("list", { name: "Changes" })).toBeNull();
    expect(screen.getByText("old_string:")).toBeTruthy();

    rerender(<ToolCallBox toolCall={editCall(args)} />);
    expect(diffRows()).toHaveLength(2);
    expect(header().textContent).toContain("+1");
  });

  // Stopped before its result: the edit may not have happened.
  it("keeps the args of a call that stopped without a result", () => {
    render(
      <ToolCallBox
        toolCall={{
          ...editCall({ old_string: "a", new_string: "b" }),
          status: "stopped",
          result: undefined,
        }}
      />
    );

    expect(header().textContent).not.toMatch(/[+−]\d/);
    fireEvent.click(header());
    expect(screen.queryByRole("list", { name: "Changes" })).toBeNull();
    expect(screen.getByText("old_string:")).toBeTruthy();
  });

  it("leaves other tools as they were", () => {
    render(
      <ToolCallBox
        toolCall={{
          id: "tc-ls",
          name: "execute",
          args: { command: "ls" },
          status: "completed",
          result: "a.txt",
        }}
      />
    );
    fireEvent.click(header());

    expect(screen.getByText("command:")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Changes" })).toBeNull();
  });
});
