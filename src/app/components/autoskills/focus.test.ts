// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusFirst } from "./focus";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function button(label: string, attach = true): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  if (attach) document.body.append(b);
  return b;
}

describe("focusFirst", () => {
  it("skips missing, detached and disabled targets and never scrolls", () => {
    const detached = button("detached", false);
    const disabled = button("disabled");
    disabled.disabled = true;
    const target = button("target");
    const after = button("after");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    focusFirst([null, undefined, detached, disabled, target, after]);

    expect(document.activeElement).toBe(target);
    expect(focus.mock.calls).toEqual([[{ preventScroll: true }]]);
  });

  it("moves on when a target doesn't take the focus", () => {
    // A heading without tabindex can't be focused.
    const heading = document.createElement("h3");
    document.body.append(heading);
    const target = button("target");

    focusFirst([heading, target]);

    expect(document.activeElement).toBe(target);
  });

  it("leaves the focus alone when nothing takes it", () => {
    const disabled = button("disabled");
    disabled.disabled = true;
    focusFirst([disabled, null]);
    expect(document.activeElement).toBe(document.body);
  });
});
