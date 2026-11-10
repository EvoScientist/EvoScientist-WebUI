// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import type { SettingSource, SettingsWriteAccess } from "@/lib/settings";

// jsdom has no scrollIntoView; Radix Select calls it when its list opens.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

const hooks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  /** Where each value comes from; an override hides the saved one. */
  sources: {} as Record<string, SettingSource>,
  revision: "rev1" as string | null,
  /** A payload without the `revision` key (a malformed answer). */
  noRevision: false,
  noPayload: false,
  access: { writable: true } as SettingsWriteAccess | undefined,
  refresh: vi.fn(),
}));

vi.mock("@/app/hooks/useSettings", () => ({
  useSettings: () => ({
    payload: hooks.noPayload
      ? undefined
      : {
          settings: hooks.settings,
          sources: hooks.sources,
          providers: {},
          read_only: [],
          setup_needed: false,
          ...(hooks.noRevision ? {} : { revision: hooks.revision }),
        },
    refresh: hooks.refresh,
  }),
  useSettingsAccess: () => ({ access: hooks.access, refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { AutoSkillsSettings } from "./AutoSkillsSettings";

const SAVED = {
  memory_skill_synthesis_enabled: true,
  memory_skill_synthesis_mode: "review",
  memory_skill_synthesis_cadence: "weekly",
  memory_skill_synthesis_time: "03:00",
  scheduler_default_timezone: "",
};

let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function panel(onOpenChange = vi.fn()) {
  return render(
    <AutoSkillsSettings
      open
      onOpenChange={onOpenChange}
    />
  );
}

const save = () => screen.getByRole("button", { name: "Save" });

beforeEach(() => {
  hooks.settings = { ...SAVED };
  hooks.sources = {};
  hooks.revision = "rev1";
  hooks.noRevision = false;
  hooks.noPayload = false;
  hooks.access = { writable: true };
  hooks.refresh = vi.fn().mockResolvedValue(undefined);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(toast.success).mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AutoSkillsSettings", () => {
  it("shows the saved values", () => {
    panel();
    expect(screen.getByText("AutoSkills settings")).toBeTruthy();
    expect(
      screen.getByText(
        "Saved to config.yaml for every project. Applies at once, no restart."
      )
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Draft skills from memory") as HTMLInputElement)
        .checked
    ).toBe(true);
    expect(
      (
        screen.getByLabelText(
          "Review — I approve each skill"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
    expect(
      (
        screen.getByLabelText(
          "Auto — install drafts without asking"
        ) as HTMLInputElement
      ).checked
    ).toBe(false);
    expect(screen.getByLabelText("How often").textContent).toContain(
      "Weekly (Sundays)"
    );
    expect(
      (screen.getByLabelText("At (local time)") as HTMLInputElement).value
    ).toBe("03:00");
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it("uses the core defaults for missing values", () => {
    hooks.settings = {};
    panel();
    expect(
      (screen.getByLabelText("Draft skills from memory") as HTMLInputElement)
        .checked
    ).toBe(true);
    expect(screen.getByLabelText("How often").textContent).toContain("Weekly");
  });

  it("saves only the changed fields with the revision", async () => {
    const onOpenChange = vi.fn();
    panel(onOpenChange);
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    fireEvent.change(screen.getByLabelText("At (local time)"), {
      target: { value: "05:30" },
    });
    // changed and changed back: not sent
    fireEvent.change(screen.getByLabelText("At (local time)"), {
      target: { value: "04:15" },
    });
    respond(200, { revision: "rev2", changed: [] });
    fireEvent.click(save());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      memory_skill_synthesis_mode: "auto",
      memory_skill_synthesis_time: "04:15",
      revision: "rev1",
    });
    expect(hooks.refresh).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("AutoSkills settings saved.");
  });

  it("does not send a field changed and changed back", () => {
    panel();
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    fireEvent.click(screen.getByLabelText("Review — I approve each skill"));
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it("changes the schedule with the list", async () => {
    panel();
    fireEvent.click(screen.getByLabelText("How often"));
    fireEvent.click(await screen.findByRole("option", { name: "Nightly" }));
    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      memory_skill_synthesis_cadence: "nightly",
      revision: "rev1",
    });
  });

  it("turns mode, how often and time off while drafting is off", () => {
    panel();
    fireEvent.click(screen.getByLabelText("Draft skills from memory"));
    expect(
      (
        screen.getByLabelText(
          "Review — I approve each skill"
        ) as HTMLInputElement
      ).disabled
    ).toBe(true);
    expect(
      (screen.getByLabelText("How often") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByLabelText("At (local time)") as HTMLInputElement).disabled
    ).toBe(true);
  });

  it("a stale revision re-reads, takes the new values and says so", async () => {
    const onOpenChange = vi.fn();
    panel(onOpenChange);
    hooks.refresh = vi.fn(async () => {
      hooks.settings = { ...SAVED, memory_skill_synthesis_cadence: "monthly" };
      hooks.revision = "rev2";
      return {
        settings: hooks.settings,
        sources: {},
        providers: {},
        read_only: [],
        setup_needed: false,
        revision: "rev2",
      };
    });
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(409, { error: "revision_mismatch" });
    fireEvent.click(save());
    expect(
      await screen.findByText(
        "These settings changed elsewhere. Showing what is saved now."
      )
    ).toBeTruthy();
    expect(hooks.refresh).toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      (
        screen.getByLabelText(
          "Review — I approve each skill"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
    expect(screen.getByLabelText("How often").textContent).toContain("Monthly");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("keeps the edits when the re-read after a conflict fails", async () => {
    panel();
    hooks.refresh = vi.fn().mockRejectedValue(new Error("down"));
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(409, { error: "revision_mismatch" });
    fireEvent.click(save());
    expect(
      await screen.findByText(
        "These settings changed elsewhere, and reading them again failed. Your changes are kept; try again."
      )
    ).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "Auto — install drafts without asking"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the edits when the re-read answers nothing", async () => {
    panel();
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    hooks.refresh = vi.fn().mockResolvedValue(undefined);
    respond(409, { error: "revision_mismatch" });
    fireEvent.click(save());
    expect(await screen.findByText(/reading them again failed/)).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "Auto — install drafts without asking"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
  });

  it("sends the revision the edits started from, not a later one", async () => {
    const { rerender } = panel();
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    hooks.revision = "rev2";
    rerender(
      <AutoSkillsSettings
        open
        onOpenChange={vi.fn()}
      />
    );
    respond(409, { error: "revision_mismatch" });
    fireEvent.click(save());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).revision).toBe("rev1");
    expect(
      await screen.findByText(/reading them again failed|Showing what/)
    ).toBeTruthy();
  });

  it("a field changed back is not kept as an edit after a re-read", () => {
    const { rerender } = panel();
    fireEvent.click(screen.getByLabelText("How often"));
    fireEvent.click(
      screen.getByRole("option", { name: "Monthly (on the 1st)" })
    );
    fireEvent.click(screen.getByLabelText("How often"));
    fireEvent.click(screen.getByRole("option", { name: "Weekly (Sundays)" }));
    hooks.settings = { ...SAVED, memory_skill_synthesis_cadence: "nightly" };
    rerender(
      <AutoSkillsSettings
        open
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText("How often").textContent).toContain("Nightly");
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an error for a field with no place in the panel", async () => {
    panel();
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(400, {
      errors: { memory_skill_synthesis_enabled: "unknown setting" },
    });
    fireEvent.click(save());
    expect(await screen.findByText("unknown setting")).toBeTruthy();
  });

  it("ignores close requests and disables Cancel while saving", async () => {
    const onOpenChange = vi.fn();
    panel(onOpenChange);
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    let answer!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((r) => {
        answer = r;
      })
    );
    fireEvent.click(save());
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
          .disabled
      ).toBe(true)
    );
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    answer({ ok: true, status: 200, json: async () => ({}) });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("drafting off: an invalid time does not block Save and is not sent", async () => {
    panel();
    fireEvent.change(screen.getByLabelText("At (local time)"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByLabelText("Draft skills from memory"));
    expect((save() as HTMLButtonElement).disabled).toBe(false);
    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      memory_skill_synthesis_enabled: false,
      revision: "rev1",
    });
  });

  it("drafting on: an invalid time blocks Save even with another change", () => {
    panel();
    fireEvent.change(screen.getByLabelText("At (local time)"), {
      target: { value: "" },
    });
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it("a re-read that answers unsupported keeps the edits", async () => {
    panel();
    hooks.refresh = vi.fn().mockResolvedValue("unsupported");
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(409, { error: "revision_mismatch" });
    fireEvent.click(save());
    expect(await screen.findByText(/reading them again failed/)).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "Auto — install drafts without asking"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
  });

  it("a saved 200 closes and toasts even when the re-read throws", async () => {
    const onOpenChange = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    panel(onOpenChange);
    hooks.refresh = vi.fn().mockRejectedValue(new Error("down"));
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalledWith("AutoSkills settings saved.");
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });

  it("an edit a re-read made equal to the saved value is dropped, and the next edit takes the new revision", async () => {
    const { rerender } = panel();
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    hooks.settings = { ...SAVED, memory_skill_synthesis_mode: "auto" };
    hooks.revision = "rev2";
    rerender(
      <AutoSkillsSettings
        open
        onOpenChange={vi.fn()}
      />
    );
    fireEvent.click(screen.getByLabelText("How often"));
    fireEvent.click(await screen.findByRole("option", { name: "Nightly" }));
    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      memory_skill_synthesis_cadence: "nightly",
      revision: "rev2",
    });
  });

  it("a 404 re-read keeps an edit that equals the defaults", async () => {
    hooks.settings = { ...SAVED, memory_skill_synthesis_mode: "auto" };
    panel();
    hooks.refresh = vi.fn(async () => {
      hooks.noPayload = true;
      return "unsupported";
    });
    fireEvent.click(screen.getByLabelText("Review — I approve each skill"));
    respond(409, { error: "revision_mismatch" });
    fireEvent.click(save());
    expect(await screen.findByText(/reading them again failed/)).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "Review — I approve each skill"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
    expect((save() as HTMLButtonElement).disabled).toBe(false);
    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      memory_skill_synthesis_mode: "review",
      revision: "rev1",
    });
  });

  it("a re-read payload without a revision keeps the edits", async () => {
    panel();
    hooks.refresh = vi.fn().mockResolvedValue({
      settings: SAVED,
      sources: {},
      providers: {},
      read_only: [],
      setup_needed: false,
    });
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(409, { error: "revision_mismatch" });
    fireEvent.click(save());
    expect(await screen.findByText(/reading them again failed/)).toBeTruthy();
  });

  it("a payload without a revision key is not taken as the saved values", async () => {
    const { rerender } = panel();
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    // Read again, answering a body without a revision: were it taken, the
    // edit would equal its "saved" value and be dropped.
    hooks.settings = { ...SAVED, memory_skill_synthesis_mode: "auto" };
    hooks.noRevision = true;
    rerender(
      <AutoSkillsSettings
        open
        onOpenChange={vi.fn()}
      />
    );
    expect(
      (
        screen.getByLabelText(
          "Auto — install drafts without asking"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
    expect((save() as HTMLButtonElement).disabled).toBe(false);
    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      memory_skill_synthesis_mode: "auto",
      revision: "rev1",
    });
  });

  it("a conflict re-read answering a null revision shows what is saved now", async () => {
    // config.yaml went away between the read and the save.
    panel();
    hooks.refresh = vi.fn(async () => {
      hooks.settings = { ...SAVED, memory_skill_synthesis_cadence: "monthly" };
      hooks.revision = null;
      return {
        settings: hooks.settings,
        sources: {},
        providers: {},
        read_only: [],
        setup_needed: false,
        revision: null,
      };
    });
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(409, { error: "revision_mismatch" });
    fireEvent.click(save());
    expect(
      await screen.findByText(
        "These settings changed elsewhere. Showing what is saved now."
      )
    ).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "Review — I approve each skill"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
    expect(screen.getByLabelText("How often").textContent).toContain("Monthly");
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  // SWR's mutate answers with the cached payload when the re-read fails: a
  // re-read is new only with the revision the conflict named (or, without
  // one, another revision than the one sent).
  const oldPayload = () => ({
    settings: SAVED,
    sources: {},
    providers: {},
    read_only: [],
    setup_needed: false,
    revision: "rev1",
  });

  it("a conflict re-read that hands back the old answer keeps the edits", async () => {
    panel();
    hooks.refresh = vi.fn().mockResolvedValue(oldPayload());
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(409, { error: "revision_mismatch", revision: "rev2" });
    fireEvent.click(save());
    expect(await screen.findByText(/reading them again failed/)).toBeTruthy();
    expect(screen.queryByText(/Showing what is saved now/)).toBeNull();
    expect(
      (
        screen.getByLabelText(
          "Auto — install drafts without asking"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });

  it("without the conflict's revision, an answer with the revision sent is the old one", async () => {
    panel();
    hooks.refresh = vi.fn().mockResolvedValue(oldPayload());
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(409, { error: "revision_mismatch" });
    fireEvent.click(save());
    expect(await screen.findByText(/reading them again failed/)).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "Auto — install drafts without asking"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
  });

  it("a conflict re-read with the conflict's revision shows what is saved now", async () => {
    panel();
    hooks.refresh = vi.fn(async () => {
      hooks.settings = { ...SAVED, memory_skill_synthesis_cadence: "monthly" };
      hooks.revision = "rev2";
      return { ...oldPayload(), settings: hooks.settings, revision: "rev2" };
    });
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(409, { error: "revision_mismatch", revision: "rev2" });
    fireEvent.click(save());
    expect(
      await screen.findByText(
        "These settings changed elsewhere. Showing what is saved now."
      )
    ).toBeTruthy();
    expect(screen.getByLabelText("How often").textContent).toContain("Monthly");
  });

  it("the revision sent comes only from the edits sent", async () => {
    const { rerender } = panel();
    // A bad time, started at rev1: not sent while drafting is off.
    fireEvent.change(screen.getByLabelText("At (local time)"), {
      target: { value: "" },
    });
    hooks.revision = "rev2";
    rerender(
      <AutoSkillsSettings
        open
        onOpenChange={vi.fn()}
      />
    );
    fireEvent.click(screen.getByLabelText("Draft skills from memory"));
    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      memory_skill_synthesis_enabled: false,
      revision: "rev2",
    });
  });

  it("Save is the default button, readable in both themes", () => {
    panel();
    const classes = save().className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        "bg-[var(--brand-solid)]",
        "text-[var(--brand-foreground)]",
      ])
    );
    // White on the hover colour was about 2.7:1 in dark mode.
    expect(classes).not.toContain("text-white");
    expect(classes).not.toContain("hover:bg-[var(--brand-hover)]");
  });

  it("sends the revision of the oldest edit still pending", async () => {
    const { rerender } = panel();
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    hooks.settings = { ...SAVED, memory_skill_synthesis_time: "04:00" };
    hooks.revision = "rev2";
    rerender(
      <AutoSkillsSettings
        open
        onOpenChange={vi.fn()}
      />
    );
    fireEvent.click(screen.getByLabelText("How often"));
    fireEvent.click(await screen.findByRole("option", { name: "Nightly" }));
    fireEvent.click(screen.getByLabelText("Review — I approve each skill"));
    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      memory_skill_synthesis_cadence: "nightly",
      revision: "rev2",
    });
  });

  it("closes and toasts at once when the re-read never settles", async () => {
    const onOpenChange = vi.fn();
    panel(onOpenChange);
    hooks.refresh = vi.fn(() => new Promise(() => {}));
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalledWith("AutoSkills settings saved.");
  });

  it("links the time error to the time field", () => {
    panel();
    fireEvent.change(screen.getByLabelText("At (local time)"), {
      target: { value: "" },
    });
    const input = screen.getByLabelText("At (local time)");
    const id = input.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id as string)?.textContent).toBe(
      "Enter a time like 03:00."
    );
  });

  it("returns the focus to the given element on Cancel and after a save", async () => {
    const target = document.createElement("button");
    document.body.appendChild(target);
    const ref = { current: target };
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <AutoSkillsSettings
        open
        onOpenChange={onOpenChange}
        returnFocusTo={ref}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    rerender(
      <AutoSkillsSettings
        open={false}
        onOpenChange={onOpenChange}
        returnFocusTo={ref}
      />
    );
    await waitFor(() => expect(document.activeElement).toBe(target));
    target.blur();
    rerender(
      <AutoSkillsSettings
        open
        onOpenChange={onOpenChange}
        returnFocusTo={ref}
      />
    );
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledTimes(2));
    rerender(
      <AutoSkillsSettings
        open={false}
        onOpenChange={onOpenChange}
        returnFocusTo={ref}
      />
    );
    await waitFor(() => expect(document.activeElement).toBe(target));
    target.remove();
  });

  it("shows server errors under their field", async () => {
    panel();
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(400, { errors: { memory_skill_synthesis_mode: "Not a mode." } });
    fireEvent.click(save());
    expect(await screen.findByText("Not a mode.")).toBeTruthy();
  });

  // The relay may have passed the save on before its answer was lost.
  it("a save the server never answered isn't called unsaved, and the settings are read again", async () => {
    const onOpenChange = vi.fn();
    panel(onOpenChange);
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    fetchMock.mockRejectedValueOnce(new Error("down"));
    fireEvent.click(save());
    expect(
      await screen.findByText(
        "The WebUI server did not answer, so the page can't tell whether the settings were saved. They are being read again."
      )
    ).toBeTruthy();
    expect(screen.queryByText(/Nothing was saved/)).toBeNull();
    expect(hooks.refresh).toHaveBeenCalledTimes(1);
    // The panel stays, with the edit, and nothing claims a save.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(
      (
        screen.getByLabelText(
          "Auto — install drafts without asking"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
    await waitFor(() =>
      expect((save() as HTMLButtonElement).disabled).toBe(false)
    );
  });

  // One case each: a panel takes a while to render on a loaded machine.
  // Plain functions, not mocks: a mock handles the promise it returns, which
  // would hide a rejection nobody else handles.
  it.each<[string, () => Promise<unknown>]>([
    ["rejects", () => Promise.reject(new Error("down"))],
    [
      "throws",
      () => {
        throw new Error("down");
      },
    ],
    ["never answers", () => new Promise(() => {})],
  ])(
    "that re-read leaves the panel usable when it %s",
    async (_how, reread) => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        let reads = 0;
        hooks.refresh = (() => {
          reads += 1;
          return reread();
        }) as unknown as typeof hooks.refresh;
        panel();
        fireEvent.click(
          screen.getByLabelText("Auto — install drafts without asking")
        );
        fetchMock.mockRejectedValueOnce(new Error("down"));
        fireEvent.click(save());
        expect(
          await screen.findByText(/They are being read again\./)
        ).toBeTruthy();
        expect(reads).toBe(1);
        await waitFor(() =>
          expect((save() as HTMLButtonElement).disabled).toBe(false)
        );
        await new Promise((r) => setTimeout(r, 10));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    }
  );

  it("words any other refusal with the settings wording", async () => {
    panel();
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    respond(423, { error: "config_locked" });
    fireEvent.click(save());
    expect(
      await screen.findByText(/Another EvoScientist command holds/)
    ).toBeTruthy();
  });

  it("an empty time disables Save and says why", () => {
    panel();
    fireEvent.change(screen.getByLabelText("At (local time)"), {
      target: { value: "" },
    });
    expect(screen.getByText("Enter a time like 03:00.")).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables everything with the reason when the page can't save", () => {
    hooks.access = { writable: false, reason: "other_backend" };
    panel();
    expect(
      (screen.getByLabelText("Draft skills from memory") as HTMLInputElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByLabelText("At (local time)") as HTMLInputElement).disabled
    ).toBe(true);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(/not the EvoScientist that runs next to this WebUI/)
    ).toBeTruthy();
  });

  it("disables everything with no text while the access is unknown", () => {
    hooks.access = undefined;
    panel();
    expect(
      (screen.getByLabelText("Draft skills from memory") as HTMLInputElement)
        .disabled
    ).toBe(true);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Checking whether/)).toBeNull();
  });

  it("names the scheduler timezone when one is set", () => {
    hooks.settings = { ...SAVED, scheduler_default_timezone: "Asia/Shanghai" };
    panel();
    expect(screen.getByLabelText("At (Asia/Shanghai)")).toBeTruthy();
  });

  it("Cancel closes without saving", () => {
    const onOpenChange = vi.fn();
    panel(onOpenChange);
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts from the saved values each time it opens", () => {
    const { rerender } = panel();
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    rerender(
      <AutoSkillsSettings
        open={false}
        onOpenChange={vi.fn()}
      />
    );
    rerender(
      <AutoSkillsSettings
        open
        onOpenChange={vi.fn()}
      />
    );
    expect(
      (
        screen.getByLabelText(
          "Review — I approve each skill"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
  });

  it("takes re-read saved values with no edits and keeps edits otherwise", () => {
    const { rerender } = panel();
    hooks.settings = { ...SAVED, memory_skill_synthesis_cadence: "monthly" };
    rerender(
      <AutoSkillsSettings
        open
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText("How often").textContent).toContain("Monthly");
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    hooks.settings = { ...SAVED, memory_skill_synthesis_cadence: "nightly" };
    rerender(
      <AutoSkillsSettings
        open
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText("How often").textContent).toContain("Nightly");
    expect(
      (
        screen.getByLabelText(
          "Auto — install drafts without asking"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
  });
});

// The core applies EVOSCIENTIST_MEMORY_SKILL_SYNTHESIS_* over config.yaml:
// GET /api/settings marks such a field `shadowed`, with the saved value only.
describe("AutoSkillsSettings with a value an override hides", () => {
  const ENV: SettingSource = { source: "env", shadowed: true };
  const NOTE =
    "Set by an environment variable, which overrides the saved value. Change it there.";
  const enabled = () =>
    screen.getByLabelText("Draft skills from memory") as HTMLInputElement;
  const review = () =>
    screen.getByLabelText("Review — I approve each skill") as HTMLInputElement;
  const auto = () =>
    screen.getByLabelText(
      "Auto — install drafts without asking"
    ) as HTMLInputElement;
  const cadence = () => screen.getByLabelText("How often") as HTMLButtonElement;
  const time = () =>
    screen.getByLabelText("At (local time)") as HTMLInputElement;
  /** The note a control is described by. */
  const describedBy = (el: HTMLElement) =>
    (el.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  const again = (view: ReturnType<typeof panel>) =>
    view.rerender(
      <AutoSkillsSettings
        open
        onOpenChange={vi.fn()}
      />
    );

  it("the control is off and carries the Setup page's note", () => {
    const cases: Array<{
      field: string;
      off: () => boolean[];
      on: () => boolean[];
      described: () => HTMLElement;
    }> = [
      {
        field: "memory_skill_synthesis_enabled",
        off: () => [enabled().disabled],
        on: () => [
          review().disabled,
          auto().disabled,
          cadence().disabled,
          time().disabled,
        ],
        described: enabled,
      },
      {
        field: "memory_skill_synthesis_mode",
        off: () => [review().disabled, auto().disabled],
        on: () => [enabled().disabled, cadence().disabled, time().disabled],
        described: () => review().closest("fieldset") as HTMLElement,
      },
      {
        field: "memory_skill_synthesis_cadence",
        off: () => [cadence().disabled],
        on: () => [
          enabled().disabled,
          review().disabled,
          auto().disabled,
          time().disabled,
        ],
        described: cadence,
      },
      {
        field: "memory_skill_synthesis_time",
        off: () => [time().disabled],
        on: () => [
          enabled().disabled,
          review().disabled,
          auto().disabled,
          cadence().disabled,
        ],
        described: time,
      },
    ];
    for (const c of cases) {
      hooks.sources = { [c.field]: ENV };
      const view = panel();
      expect(c.off(), c.field).not.toContain(false);
      expect(c.on(), c.field).not.toContain(true);
      expect(screen.getAllByText(NOTE), c.field).toHaveLength(1);
      expect(describedBy(c.described()), c.field).toBe(NOTE);
      view.unmount();
    }
  });

  it("no note without an override, also for a source that hides nothing", () => {
    hooks.sources = {
      memory_skill_synthesis_enabled: { source: "config", shadowed: false },
    };
    panel();
    expect(screen.queryByText(/overrides the saved value/)).toBeNull();
    expect(enabled().disabled).toBe(false);
    expect(enabled().getAttribute("aria-describedby")).toBeNull();
  });

  it("names where the override comes from, as the Setup page does", () => {
    hooks.sources = {
      memory_skill_synthesis_time: {
        source: "dotenv",
        path: "/w/.env",
        shadowed: true,
      },
    };
    panel();
    expect(
      screen.getByText(
        "Set by the .env file at /w/.env, which overrides the saved value. Change it there."
      )
    ).toBeTruthy();
  });

  it("says so on a page that can't save, too", () => {
    hooks.access = { writable: false, reason: "not_loopback" };
    hooks.sources = { memory_skill_synthesis_enabled: ENV };
    panel();
    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  it("a saved off that an override hides doesn't turn the other controls off", async () => {
    // Whether drafting is on isn't known: the schedule stays editable.
    hooks.settings = { ...SAVED, memory_skill_synthesis_enabled: false };
    hooks.sources = { memory_skill_synthesis_enabled: ENV };
    panel();
    expect(enabled().checked).toBe(false);
    expect(enabled().disabled).toBe(true);
    expect(review().disabled).toBe(false);
    expect(cadence().disabled).toBe(false);
    expect(time().disabled).toBe(false);

    // A bad time blocks Save there, as with drafting on.
    fireEvent.change(time(), { target: { value: "" } });
    expect(screen.getByText("Enter a time like 03:00.")).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(time(), { target: { value: "05:30" } });
    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      memory_skill_synthesis_time: "05:30",
      revision: "rev1",
    });
  });

  it("an overridden field is never sent, also when it was edited before the override showed", async () => {
    const view = panel();
    fireEvent.click(auto());
    fireEvent.change(time(), { target: { value: "05:30" } });
    expect((save() as HTMLButtonElement).disabled).toBe(false);

    // The settings are read again (EvoScientist restarted with the
    // variable): the mode shows what is saved, and its edit doesn't go.
    hooks.sources = { memory_skill_synthesis_mode: ENV };
    again(view);
    expect(auto().disabled).toBe(true);
    expect(auto().checked).toBe(false);
    expect(review().checked).toBe(true);

    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      memory_skill_synthesis_time: "05:30",
      revision: "rev1",
    });
  });

  // The panel keeps the last real answer for a read that answers nothing.
  // An override can come or go with config.yaml untouched (EvoScientist
  // restarted with or without the variable): the same settings and revision.
  it("an override that showed with the same settings and revision holds through a read that answers nothing", async () => {
    const view = panel();
    fireEvent.click(auto());
    fireEvent.change(time(), { target: { value: "05:30" } });
    hooks.sources = { memory_skill_synthesis_mode: ENV };
    again(view);
    expect(auto().disabled).toBe(true);

    hooks.noPayload = true;
    again(view);
    expect(auto().disabled).toBe(true);
    expect(auto().checked).toBe(false);
    expect(review().checked).toBe(true);
    expect(screen.getAllByText(NOTE)).toHaveLength(1);

    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      memory_skill_synthesis_time: "05:30",
      revision: "rev1",
    });
  });

  it("an override that went away with the same settings and revision stays away through a read that answers nothing", () => {
    hooks.sources = { memory_skill_synthesis_mode: ENV };
    const view = panel();
    expect(auto().disabled).toBe(true);
    hooks.sources = {};
    again(view);
    expect(auto().disabled).toBe(false);

    hooks.noPayload = true;
    again(view);
    expect(auto().disabled).toBe(false);
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  // The core's AutoSkills schedule runs in the timezone in use, which an
  // override of scheduler_default_timezone hides: the label names none.
  it("the time label names no timezone when an override hides the saved one", () => {
    hooks.settings = { ...SAVED, scheduler_default_timezone: "Asia/Shanghai" };
    hooks.sources = { scheduler_default_timezone: ENV };
    panel();
    const field = screen.getByLabelText("At") as HTMLInputElement;
    expect(field.id).toBe("autoskills-time");
    expect(screen.queryByLabelText(/Asia\/Shanghai/)).toBeNull();
    expect(screen.queryByLabelText(/local time/)).toBeNull();
    // The time itself isn't overridden.
    expect(field.disabled).toBe(false);
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('nor "local time" when none is saved and an override sets one', () => {
    hooks.sources = { scheduler_default_timezone: ENV };
    panel();
    expect(screen.getByLabelText("At")).toBeTruthy();
    expect(screen.queryByLabelText(/local time/)).toBeNull();
  });

  it("a timezone source that hides nothing keeps the saved zone in the label", () => {
    hooks.settings = { ...SAVED, scheduler_default_timezone: "Asia/Shanghai" };
    hooks.sources = {
      scheduler_default_timezone: { source: "config", shadowed: false },
    };
    panel();
    expect(screen.getByLabelText("At (Asia/Shanghai)")).toBeTruthy();
  });

  it("with only an overridden field edited there is nothing to save", () => {
    const view = panel();
    fireEvent.click(auto());
    expect((save() as HTMLButtonElement).disabled).toBe(false);
    hooks.sources = { memory_skill_synthesis_mode: ENV };
    again(view);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an overridden time that isn't one doesn't block the other fields", async () => {
    // Saved by hand; the field is off, so it can't be fixed here.
    hooks.settings = { ...SAVED, memory_skill_synthesis_time: "3am" };
    hooks.sources = { memory_skill_synthesis_time: ENV };
    panel();
    expect(screen.queryByText("Enter a time like 03:00.")).toBeNull();
    fireEvent.click(auto());
    respond(200, {});
    fireEvent.click(save());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      memory_skill_synthesis_mode: "auto",
      revision: "rev1",
    });
  });
});
