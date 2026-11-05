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
import type { SettingsWriteAccess } from "@/lib/settings";

// jsdom has no scrollIntoView; Radix Select calls it when its list opens.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

const hooks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  revision: "rev1" as string | null,
  access: { writable: true } as SettingsWriteAccess | undefined,
  refresh: vi.fn(),
}));

vi.mock("@/app/hooks/useSettings", () => ({
  useSettings: () => ({
    payload: { settings: hooks.settings, revision: hooks.revision },
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
  hooks.revision = "rev1";
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

  it("a stale revision re-reads and says so", async () => {
    const onOpenChange = vi.fn();
    panel(onOpenChange);
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
    expect(toast.success).not.toHaveBeenCalled();
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

  it("says nothing was saved when the server does not answer", async () => {
    panel();
    fireEvent.click(
      screen.getByLabelText("Auto — install drafts without asking")
    );
    fetchMock.mockRejectedValueOnce(new Error("down"));
    fireEvent.click(save());
    expect(
      await screen.findByText(
        "The WebUI server did not answer. Nothing was saved."
      )
    ).toBeTruthy();
  });

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
