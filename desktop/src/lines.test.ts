import { describe, expect, it } from "vitest";
import {
  LineSplitter,
  isTerminal,
  parseDeployEvent,
  parseJsonLine,
  parseStageEvent,
  parseVersionInfo,
} from "./lines";

describe("LineSplitter", () => {
  it("joins lines across chunks and CRLF", () => {
    const s = new LineSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\r\n{"b":2}\npart')).toEqual(['{"a":1}', '{"b":2}']);
    expect(s.end()).toEqual(["part"]);
  });

  it("keeps a multi-byte character split across chunks", () => {
    const bytes = Buffer.from('{"p":"C:\\\\Użytkownicy"}\n', "utf8");
    const cut = bytes.indexOf(0xc5) + 1; // inside "ż"
    const s = new LineSplitter();
    expect(s.push(bytes.subarray(0, cut))).toEqual([]);
    const [line] = s.push(bytes.subarray(cut));
    expect(parseJsonLine(line)).toEqual({ p: "C:\\Użytkownicy" });
  });
});

describe("parseJsonLine", () => {
  it.each(["", "Starting...", "[1,2]", "{not json", "null"])(
    "returns null for %j",
    (l) => {
      expect(parseJsonLine(l)).toBeNull();
    }
  );
});

describe("parseVersionInfo", () => {
  it("reads C08's line", () => {
    expect(
      parseVersionInfo(
        '{"version": "0.3.8", "protocol": 1, "webui_compat": ">=0.3,<0.5"}\n'
      )
    ).toEqual({
      version: "0.3.8",
      protocol: 1,
      webuiCompat: ">=0.3,<0.5",
    });
  });

  it("is null without a complete line", () => {
    expect(parseVersionInfo("EvoScientist 0.3.6\n")).toBeNull();
    expect(parseVersionInfo('{"version": "0.3.8"}')).toBeNull();
  });
});

describe("parseDeployEvent", () => {
  it("reads ready", () => {
    const e = parseDeployEvent(
      JSON.stringify({
        protocol: 1,
        event: "ready",
        url: "http://127.0.0.1:6174",
        owned: true,
        workspace: "C:\\Users\\a\\Documents\\EvoScientist",
        assistant_id: "x",
        data_dir: "C:\\Users\\a\\.evoscientist",
        config_dir: "C:\\Users\\a\\.config\\evoscientist",
        log_file: "C:\\Users\\a\\.config\\evoscientist\\langgraph_dev.log",
        warnings: ["w", 3],
        later_field: true,
      })
    );
    expect(e).toMatchObject({
      event: "ready",
      url: "http://127.0.0.1:6174",
      owned: true,
      warnings: ["w"],
    });
  });

  it("reads an error with its detail", () => {
    expect(
      parseDeployEvent(
        '{"protocol":1,"event":"error","code":"port_conflict","message":"m","detail":{"reason":"foreign"}}'
      )
    ).toEqual({
      event: "error",
      code: "port_conflict",
      message: "m",
      detail: { reason: "foreign" },
    });
  });

  it("passes unknown events and an incomplete ready through as other", () => {
    expect(parseDeployEvent('{"protocol":1,"event":"tunnel"}')).toMatchObject({
      event: "other",
    });
    expect(parseDeployEvent('{"protocol":1,"event":"ready"}')).toMatchObject({
      event: "other",
    });
  });

  it("is null for a line without an event", () => {
    expect(parseDeployEvent('{"stage":"node","status":"done"}')).toBeNull();
  });
});

describe("parseStageEvent", () => {
  it("reads a running line and a terminal error", () => {
    const running = parseStageEvent(
      '{"protocol":1,"stage":"node","status":"running","progress":0.5,"message":"m"}'
    );
    expect(running).toMatchObject({
      stage: "node",
      status: "running",
      progress: 0.5,
    });
    expect(isTerminal(running!)).toBe(false);
    const error = parseStageEvent(
      '{"protocol":1,"stage":"update","status":"error","code":"manual_update"}'
    );
    expect(error).toMatchObject({ code: "manual_update" });
    expect(isTerminal(error!)).toBe(true);
  });

  it("is null for an unknown status", () => {
    expect(parseStageEvent('{"stage":"node","status":"paused"}')).toBeNull();
  });
});
