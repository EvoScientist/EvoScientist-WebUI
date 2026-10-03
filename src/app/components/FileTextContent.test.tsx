// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FileTextContent } from "./FileTextContent";

const PAGE = "<!doctype html><title>Hi</title><p>hello page</p>";
const frame = (container: HTMLElement) => container.querySelector("iframe");

const highlights = vi.hoisted(() => ({ count: 0 }));
vi.mock("react-syntax-highlighter", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("react-syntax-highlighter")
  >();
  const Prism = (props: React.ComponentProps<typeof real.Prism>) => {
    highlights.count += 1;
    return <real.Prism {...props} />;
  };
  return { ...real, Prism };
});

describe("FileTextContent", () => {
  it("renders Markdown, code and empty files", () => {
    const { rerender, container } = render(
      <FileTextContent
        content={"# Title\n\nbody"}
        ext="md"
      />
    );
    expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
    rerender(
      <FileTextContent
        content="print(1)"
        ext="py"
      />
    );
    expect(container.querySelector("code")?.textContent).toContain("print");
    rerender(
      <FileTextContent
        content=""
        ext="py"
      />
    );
    expect(screen.getByText("File is empty")).toBeTruthy();
  });

  it("doesn't highlight again when only its parent re-renders", () => {
    // Every open tab re-renders on each refresh tick; highlighting a big
    // file again each time would block the page during a run.
    function Host({ tick }: { tick: number }) {
      return (
        <div data-tick={tick}>
          <FileTextContent
            content="print(1)"
            ext="py"
          />
        </div>
      );
    }
    highlights.count = 0;
    const { rerender } = render(<Host tick={0} />);
    rerender(<Host tick={1} />);
    rerender(<Host tick={2} />);
    expect(highlights.count).toBe(1);
  });

  describe("HTML files", () => {
    it("shows the page in a sandbox that can run scripts but not reach the app", () => {
      // No allow-same-origin: the page gets an opaque origin, so it can't
      // read the app's storage or call its file APIs.
      const { container } = render(
        <FileTextContent
          content={PAGE}
          ext="html"
        />
      );
      const page = frame(container);
      expect(page?.getAttribute("sandbox")).toBe(
        "allow-scripts allow-popups allow-popups-to-escape-sandbox"
      );
      expect(page?.getAttribute("srcdoc")).toBe(PAGE);
      expect(
        screen
          .getByRole("button", { name: "Preview" })
          .getAttribute("aria-pressed")
      ).toBe("true");
    });

    it("switches between the page and its source", () => {
      const { container } = render(
        <FileTextContent
          content={PAGE}
          ext="html"
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Source" }));
      expect(frame(container)).toBeNull();
      expect(container.querySelector("code")?.textContent).toContain(
        "hello page"
      );
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
      expect(frame(container)?.getAttribute("srcdoc")).toBe(PAGE);
    });

    it("keeps the page loaded until its content changes", () => {
      // Each refresh tick re-renders open tabs; reloading the page then
      // would throw away what the user did in it.
      function Host({ tick, content }: { tick: number; content: string }) {
        return (
          <div data-tick={tick}>
            <FileTextContent
              content={content}
              ext="html"
            />
          </div>
        );
      }
      const { container, rerender } = render(
        <Host
          tick={0}
          content={PAGE}
        />
      );
      const first = frame(container);
      rerender(
        <Host
          tick={1}
          content={PAGE}
        />
      );
      expect(frame(container)).toBe(first);
      rerender(
        <Host
          tick={2}
          content="<p>second version</p>"
        />
      );
      expect(frame(container)?.getAttribute("srcdoc")).toBe(
        "<p>second version</p>"
      );
    });

    it("still says when the file is empty", () => {
      const { container } = render(
        <FileTextContent
          content=""
          ext="html"
        />
      );
      expect(frame(container)).toBeNull();
      expect(screen.getByText("File is empty")).toBeTruthy();
    });
  });
});
