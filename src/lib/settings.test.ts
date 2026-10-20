import { describe, expect, it } from "vitest";
import {
  isLocalDeployment,
  isSettingsPayload,
  settingsWriteAccess,
  type SettingsAccess,
} from "@/lib/settings";

const ACCESS: SettingsAccess = {
  writable: true,
  port: 6174,
  instance: "0123456789abcdef",
  revision: "rev-1",
};

describe("isLocalDeployment", () => {
  it.each([
    "http://127.0.0.1:6174",
    "http://localhost:6174/",
    "http://[::1]:6174",
    "http://LOCALHOST:6174",
  ])("accepts %s", (url) => {
    expect(isLocalDeployment(url, 6174)).toBe(true);
  });

  it.each([
    ["another port", "http://127.0.0.1:6606"],
    ["a LAN address", "http://192.168.1.10:6174"],
    ["a DNS name", "http://evo.example.com:6174"],
    ["https", "https://127.0.0.1:6174"],
    ["the default port", "http://127.0.0.1"],
    ["no URL", "not a url"],
  ])("refuses %s", (_, url) => {
    expect(isLocalDeployment(url, 6174)).toBe(false);
  });

  it("reads a missing port as 80", () => {
    expect(isLocalDeployment("http://localhost", 80)).toBe(true);
  });
});

describe("settingsWriteAccess", () => {
  const URL = "http://127.0.0.1:6174";

  it("passes the relay's refusal through", () => {
    expect(
      settingsWriteAccess(
        URL,
        { writable: false, reason: "not_loopback" },
        { instance: ACCESS.instance, revision: "rev-1" }
      )
    ).toEqual({ writable: false, reason: "not_loopback" });
  });

  it("is writable when the page reads the backend the relay writes to", () => {
    expect(
      settingsWriteAccess(URL, ACCESS, {
        instance: ACCESS.instance,
        revision: "rev-1",
      })
    ).toEqual({ writable: true });
  });

  it("refuses a deployment URL that is not the relay's backend", () => {
    expect(
      settingsWriteAccess("http://127.0.0.1:6606", ACCESS, {
        instance: ACCESS.instance,
        revision: "rev-1",
      })
    ).toEqual({ writable: false, reason: "other_backend" });
  });

  it("refuses another backend on the same address, even with the same config", () => {
    // A laptop's own backend on 127.0.0.1:6174 while the relay writes to the
    // tunnelled one: same port, same revision, different instance.
    expect(
      settingsWriteAccess(URL, ACCESS, {
        instance: "fedcba9876543210",
        revision: "rev-1",
      })
    ).toEqual({ writable: false, reason: "other_backend" });
  });

  it("compares the revision when the backend has no instance field", () => {
    expect(settingsWriteAccess(URL, ACCESS, { revision: "rev-1" })).toEqual({
      writable: true,
    });
    expect(
      settingsWriteAccess(URL, ACCESS, { instance: null, revision: "rev-2" })
    ).toEqual({ writable: false, reason: "other_backend" });
  });

  it("matches two missing config files without an instance field", () => {
    // The case the instance field closes; without it the fallback cannot.
    expect(
      settingsWriteAccess(
        URL,
        { ...ACCESS, revision: null },
        { revision: null }
      )
    ).toEqual({ writable: true });
  });
});

describe("isSettingsPayload", () => {
  const payload = {
    settings: {},
    sources: {},
    read_only: [],
    providers: {},
    setup_needed: false,
    restart_required: false,
    restart_fields: [],
    revision: null,
    config_error: null,
  };

  it("accepts the backend's body", () => {
    expect(isSettingsPayload(payload)).toBe(true);
  });

  it.each([null, "x", [], { ...payload, settings: null }, { error: "x" }])(
    "refuses %j",
    (value) => {
      expect(isSettingsPayload(value)).toBe(false);
    }
  );
});
