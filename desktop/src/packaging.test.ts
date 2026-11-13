import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIRST_RELEASE_CORE,
  appLayout,
  changedSince,
  releaseFlagProblem,
  tagProblem,
  versionArgs,
} from "./packaging";
import { QUIT_FOR_INSTALL, QUIT_FOR_INSTALL_CANCELLED } from "./app";

const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8")
) as {
  evoscientist: { coreRange: string; release?: unknown; releaseMac?: unknown };
  build: Record<string, unknown> & {
    nsis: Record<string, unknown>;
    publish: Record<string, unknown>;
    extraMetadata: Record<string, unknown>;
  };
};

describe("versionArgs", () => {
  it("stamps the root version into the packaged package.json", () => {
    expect(versionArgs("0.4.2")).toEqual(["-c.extraMetadata.version=0.4.2"]);
  });

  it("refuses a version that is not a plain release", () => {
    expect(() => versionArgs("0.4.2-rc.1")).toThrow(/plain release/);
    expect(() => versionArgs("")).toThrow(/plain release/);
  });
});

describe("tagProblem", () => {
  it("accepts the tag of the version", () => {
    expect(tagProblem("v0.4.2", "0.4.2")).toBeNull();
  });

  it("names a tag on another version", () => {
    expect(tagProblem("v0.4.3", "0.4.2")).toMatch(/v0\.4\.3.*v0\.4\.2/);
    expect(tagProblem("0.4.2", "0.4.2")).not.toBeNull();
  });
});

describe("releaseFlagProblem", () => {
  it("lets the flag be off with any range", () => {
    expect(releaseFlagProblem({ coreRange: ">=0.3.8,<0.4" })).toBeNull();
    expect(
      releaseFlagProblem({ coreRange: ">=0.3.8,<0.4", release: false })
    ).toBeNull();
  });

  it("refuses the flag while the range installs a core before the first release core", () => {
    expect(
      releaseFlagProblem({ coreRange: ">=0.3.8,<0.4", release: true })
    ).toMatch(/installs 0\.3\.8, before 0\.4\.1/);
    // 0.4.0 lacks the Windows clean stop (EvoScientist#716 shipped in 0.4.1).
    expect(
      releaseFlagProblem({ coreRange: ">=0.4.0,<0.5", release: true })
    ).toMatch(/installs 0\.4\.0, before 0\.4\.1/);
    expect(releaseFlagProblem({ coreRange: "<0.5", release: true })).toMatch(
      /no version/
    );
  });

  it("accepts the flag once the range installs that core or a newer one", () => {
    expect(
      releaseFlagProblem({
        coreRange: `>=${FIRST_RELEASE_CORE},<0.5`,
        release: true,
      })
    ).toBeNull();
    expect(
      releaseFlagProblem({ coreRange: ">=0.4.2,<0.5", release: true })
    ).toBeNull();
  });

  it("holds for this package.json", () => {
    expect(releaseFlagProblem(pkg.evoscientist)).toBeNull();
  });

  // On since the first desktop release (0.5.1); the check above holds with
  // the flag off too.
  it("is on in this package.json", () => {
    expect(pkg.evoscientist.release).toBe(true);
  });

  // The release job uploads the macOS files next to the Windows ones, and
  // the publish job publishes without desktop files while the installer is
  // not built.
  it("refuses the macOS switch while the release switch is off", () => {
    const range = `>=${FIRST_RELEASE_CORE},<0.5`;
    expect(
      releaseFlagProblem({ coreRange: range, release: false, releaseMac: true })
    ).toMatch(/releaseMac is on, but release is off/);
    expect(releaseFlagProblem({ coreRange: range, releaseMac: true })).toMatch(
      /releaseMac is on, but release is off/
    );
    expect(
      releaseFlagProblem({ coreRange: range, release: true, releaseMac: true })
    ).toBeNull();
    expect(
      releaseFlagProblem({ coreRange: range, release: true, releaseMac: false })
    ).toBeNull();
  });

  // Off until a signed, notarized build has been made and updated once:
  // a tag then builds no macOS files, as before.
  it("keeps the macOS release off in this package.json", () => {
    expect(pkg.evoscientist.releaseMac).toBe(false);
  });
});

// Where electron-builder puts the unpacked app, for the smoke test.
describe("appLayout", () => {
  it("is the unpacked folder, the executable and the resources per platform", () => {
    expect(appLayout("win32", "C:/r")).toEqual({
      appDir: join("C:/r", "win-unpacked"),
      exe: join("C:/r", "win-unpacked", "EvoScientist.exe"),
      resources: join("C:/r", "win-unpacked", "resources"),
    });
    expect(appLayout("linux", "/r")).toEqual({
      appDir: join("/r", "linux-unpacked"),
      exe: join("/r", "linux-unpacked", "evoscientist"),
      resources: join("/r", "linux-unpacked", "resources"),
    });
  });

  it("on macOS is the app bundle, with both inside Contents", () => {
    const app = join("/r", "mac-arm64", "EvoScientist.app");
    expect(appLayout("darwin", "/r")).toEqual({
      appDir: app,
      exe: join(app, "Contents", "MacOS", "EvoScientist"),
      resources: join(app, "Contents", "Resources"),
    });
  });

  it("takes another app folder, as --app gives one", () => {
    const app = join("/Applications", "EvoScientist.app");
    expect(appLayout("darwin", "/r", app)).toEqual({
      appDir: app,
      exe: join(app, "Contents", "MacOS", "EvoScientist"),
      resources: join(app, "Contents", "Resources"),
    });
    expect(appLayout("linux", "/r", "/opt/app").exe).toBe(
      join("/opt/app", "evoscientist")
    );
  });

  // A fork's test build has its own product name: the bundle and the
  // executable in it carry that name.
  it("on macOS names the executable after the bundle", () => {
    const app = join("/r", "mac-arm64", "W04Test.app");
    expect(appLayout("darwin", "/r", app)).toEqual({
      appDir: app,
      exe: join(app, "Contents", "MacOS", "W04Test"),
      resources: join(app, "Contents", "Resources"),
    });
  });
});

// The smoke test's check that the UI server leaves the app's folder alone.
describe("changedSince", () => {
  it("lists what was added or changed in a folder after a moment, at any depth", () => {
    const dir = mkdtempSync(join(tmpdir(), "evo-changed-"));
    try {
      mkdirSync(join(dir, "a", "b"), { recursive: true });
      writeFileSync(join(dir, "kept.txt"), "1");
      writeFileSync(join(dir, "a", "b", "changed.txt"), "1");
      // Everything so far is older than the moment.
      const before = new Date(Date.now() - 60_000);
      for (const p of ["kept.txt", "a/b/changed.txt", "a/b", "a", "."])
        utimesSync(join(dir, p), before, before);
      const since = Date.now() - 30_000;
      expect(changedSince(dir, since)).toEqual([]);
      writeFileSync(join(dir, "a", "b", "changed.txt"), "2");
      mkdirSync(join(dir, "a", "cache"));
      writeFileSync(join(dir, "a", "cache", "new.bin"), "x");
      expect(changedSince(dir, since).sort()).toEqual(
        [
          "a",
          join("a", "b", "changed.txt"),
          join("a", "cache"),
          join("a", "cache", "new.bin"),
        ].sort()
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sees a file that was removed, also one directly in the folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "evo-changed-"));
    try {
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "top.txt"), "1");
      writeFileSync(join(dir, "sub", "deep.txt"), "1");
      const before = new Date(Date.now() - 60_000);
      for (const p of ["top.txt", "sub/deep.txt", "sub", "."])
        utimesSync(join(dir, p), before, before);
      const since = Date.now() - 30_000;
      expect(changedSince(dir, since)).toEqual([]);
      rmSync(join(dir, "sub", "deep.txt"));
      expect(changedSince(dir, since)).toEqual(["sub"]);
      rmSync(join(dir, "top.txt"));
      expect(changedSince(dir, since).sort()).toEqual([".", "sub"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A link is looked at itself: one that points nowhere is no change, and
  // the walk does not leave the folder through it.
  it("looks at a symbolic link, not at what it points to", () => {
    const dir = mkdtempSync(join(tmpdir(), "evo-changed-"));
    try {
      symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
      const before = new Date(Date.now() - 60_000);
      lutimesSync(join(dir, "dangling"), before, before);
      utimesSync(dir, before, before);
      expect(changedSince(dir, Date.now() - 30_000)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A check that could not look must not pass.
  it("fails when the folder cannot be read", () => {
    expect(() => changedSince(join(tmpdir(), "evo-no-such-folder"), 0)).toThrow(
      /ENOENT/
    );
  });
});

// Upgrades, uninstall and the update feed depend on these; none may change
// after the first release.
describe("the installer's identity", () => {
  it("keeps the app id, the install folder name and the installer name", () => {
    expect(pkg.build.appId).toBe("com.evoscientist.desktop");
    // A one-click per-user install is named after the package name:
    // %LOCALAPPDATA%\Programs\EvoScientist.
    expect(pkg.build.extraMetadata.name).toBe("EvoScientist");
    expect(pkg.build.nsis.artifactName).toBe("EvoScientist-Setup.${ext}");
  });

  it("installs per user, in the default folder, and keeps user data on uninstall", () => {
    expect(pkg.build.nsis.oneClick).toBe(true);
    expect(pkg.build.nsis.perMachine).toBe(false);
    expect(pkg.build.nsis.allowToChangeInstallationDirectory).toBe(false);
    expect(pkg.build.nsis.deleteAppDataOnUninstall).toBe(false);
  });

  it("reads updates from this repository's GitHub Releases", () => {
    expect(pkg.build.publish).toEqual({
      provider: "github",
      owner: "EvoScientist",
      repo: "EvoScientist-WebUI",
    });
  });
});

// A dmg to install from and a zip for updates, Apple Silicon only. The
// names are fixed, like the Windows installer's, so a download link never
// changes with the version; they keep "arm64" because electron-updater picks
// a Mac's update file by that word.
describe("the macOS build", () => {
  const mac = pkg.build.mac as Record<string, unknown>;
  const dmg = pkg.build.dmg as Record<string, unknown>;
  const desktop = join(__dirname, "..");

  it("builds a dmg and a zip for arm64 only", () => {
    expect(mac.target).toEqual([
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ]);
  });

  it("names the files without a version", () => {
    expect(dmg.artifactName).toBe("EvoScientist-${arch}.${ext}");
    expect(mac.artifactName).toBe("EvoScientist-${arch}-mac.${ext}");
  });

  // Updates use the zip; a blockmap written for the dmg would be wrong once
  // the dmg is stapled.
  it("writes no blockmap for the dmg", () => {
    expect(dmg.writeUpdateInfo).toBe(false);
  });

  // Notarization needs the hardened runtime. electron-builder turns it on
  // by default; the line keeps it on if that default changes.
  it("signs with the hardened runtime", () => {
    expect(mac.hardenedRuntime).toBe(true);
  });

  // V8 needs the JIT entitlement under the hardened runtime, in the app and
  // in its helpers (one runs the UI server). Without files of its own
  // electron-builder signs with its template, which also turns library
  // validation off.
  it("gives the app and what inherits the JIT entitlement and nothing else", () => {
    expect(mac.entitlements).toBe("assets/mac/entitlements.mac.plist");
    expect(mac.entitlementsInherit).toBe(
      "assets/mac/entitlements.mac.inherit.plist"
    );
    for (const name of [mac.entitlements, mac.entitlementsInherit]) {
      const plist = readFileSync(join(desktop, name as string), "utf8");
      const keys = [...plist.matchAll(/<key>([^<]*)<\/key>/g)].map((m) => m[1]);
      expect(keys, name as string).toEqual(["com.apple.security.cs.allow-jit"]);
      expect(plist, name as string).toMatch(
        /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/
      );
    }
  });

  it("has an icon of its own", () => {
    expect(mac.icon).toBe("assets/mac/EvoScientist.icns");
    const icon = readFileSync(join(desktop, mac.icon as string));
    expect(icon.subarray(0, 4).toString("latin1")).toBe("icns");
  });

  // electron-builder looks for these names in `build/` and in the project
  // folder, also to make the Windows installer's icon (an icon.icns is
  // converted for it). An icon for Windows is a change of its own.
  it("keeps every default icon location empty, so Windows keeps its icon", () => {
    const names = [
      "icon.icns",
      "icon.ico",
      "icon.png",
      "icon.svg",
      "icons",
      "icon",
    ];
    for (const dir of [desktop, join(desktop, "build")])
      for (const name of names)
        expect(existsSync(join(dir, name)), join(dir, name)).toBe(false);
    expect(pkg.build.icon).toBeUndefined();
    expect((pkg.build.win as Record<string, unknown>).icon).toBeUndefined();
  });

  it("leaves the Windows and Linux builds as they were", () => {
    expect(pkg.build.win).toEqual({
      target: "nsis",
      executableName: "EvoScientist",
      signAndEditExecutable: false,
    });
    expect(pkg.build.nsis).toEqual({
      oneClick: true,
      perMachine: false,
      allowToChangeInstallationDirectory: false,
      deleteAppDataOnUninstall: false,
      artifactName: "EvoScientist-Setup.${ext}",
      include: "installer/check-app-running.nsh",
    });
    expect(pkg.build.linux).toEqual({ target: "dir" });
  });
});

describe("the installer's running-app check (D12)", () => {
  const nsh = () =>
    // A Windows checkout has CRLF line ends.
    readFileSync(
      join(__dirname, "..", String(pkg.build.nsis.include)),
      "utf8"
    ).replace(/\r\n/g, "\n");

  it("is the installer's include", () => {
    expect(pkg.build.nsis.include).toBe("installer/check-app-running.nsh");
    expect(
      existsSync(join(__dirname, "..", "installer/check-app-running.nsh"))
    ).toBe(true);
    expect(nsh()).toMatch(/^!macro customCheckAppRunning$/m);
  });

  it("asks the app to quit with the argument and waits for the marker the app writes", () => {
    expect(nsh()).toContain(
      `${"${APP_EXECUTABLE_FILENAME}"}" ${QUIT_FOR_INSTALL}\``
    );
    expect(nsh()).toContain(
      `$APPDATA\\${"${PRODUCT_NAME}"}\\${QUIT_FOR_INSTALL_CANCELLED}`
    );
  });

  const macro = (name: string) =>
    nsh().match(new RegExp(`^!macro ${name}\\b[^]*?^!macroend$`, "m"))?.[0] ??
    "";

  it("waits for the app only, then ends a UI server left alone", () => {
    const entry = (
      pkg.build.extraResources as { from: string; to: string }[]
    ).find((r) => r.from === "resources/ui-entry.mjs")?.to;
    expect(entry).toBe("ui-entry.mjs");
    expect(macro("EVO_APP_RUNNING")).toContain(
      `[string]$$_.CommandLine -notlike '*${entry}*'`
    );
    expect(macro("EVO_END_ALL")).not.toContain("CommandLine");
    expect(macro("customCheckAppRunning")).toMatch(
      /^ {2}evoDone:\n {4}!insertmacro EVO_END_ALL \$R0$/m
    );
  });

  it("matches the app's executable, passed outside the command", () => {
    // In the command line, an apostrophe in the path (a user name) would
    // break PowerShell's quoting. A folder match took an old uninstaller run
    // in place for the app, and ended it.
    expect(macro("customCheckAppRunning")).toContain(
      `SetEnvironmentVariable(t "EVO_APP_EXE", t "$INSTDIR\\${"${APP_EXECUTABLE_FILENAME}"}")`
    );
    for (const name of ["EVO_APP_RUNNING", "EVO_ANY_RUNNING", "EVO_END_ALL"])
      expect(macro(name)).toContain("$$_.Path -eq $$env:EVO_APP_EXE");
    expect(nsh()).not.toContain("StartsWith");
    expect(nsh()).not.toMatch(/'\$INSTDIR/);
  });

  it("waits 3 minutes by the clock, and stops a PowerShell or tasklist run after 30 s without output", () => {
    const check = macro("customCheckAppRunning");
    expect(check).toContain("System::Call 'kernel32::GetTickCount()i.R2'");
    expect(check).toContain(
      "IntOp $R4 $R4 - $R2\n    IntCmpU $R4 180000 evoPoll evoPoll 0\n"
    );
    const runs = nsh().match(/nsExec::Exec[^`]*`/g) ?? [];
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r).toContain("/TIMEOUT=30000");
  });

  it("installs nothing while a process of the app still runs after the ends", () => {
    // A UI server that Stop-Process could not end, or the app itself after a
    // silent run's end, would hold the files being replaced.
    expect(macro("EVO_ANY_RUNNING")).not.toContain("CommandLine");
    expect(macro("EVO_ANY_RUNNING")).toContain("{ exit 0 } else { exit 2 }");
    // No answer from either check counts as running.
    expect(macro("EVO_ANY_RUNNING")).toMatch(
      /\$\{If\} \$\{_RETURN\} != 0\n {4}\$\{AndIf\} \$\{_RETURN\} != 1\n {6}StrCpy \$\{_RETURN\} 0\n/
    );
    expect(macro("customCheckAppRunning")).toMatch(
      /!insertmacro EVO_END_ALL \$R0\n[^]*!insertmacro EVO_ANY_RUNNING \$R0\n {4}StrCmp \$R0 0 evoStill\n!macroend$/
    );
    // The "still running" box: a silent run stops there.
    const box = macro("customCheckAppRunning").split("evoStill:")[1] ?? "";
    for (const line of box
      .split("\n")
      .filter((l) => l.includes("MB_RETRYCANCEL")))
      expect(line).toContain("/SD IDCANCEL IDRETRY evoCheck");
  });

  it("exits with code 2 whenever it stops, and names Task Manager in the box", () => {
    // A silent run's caller would otherwise see success with nothing done.
    const check = macro("customCheckAppRunning");
    const quits = check.match(/^.*\n {4}Quit$/gm) ?? [];
    expect(quits).toHaveLength(2);
    for (const q of quits) expect(q).toMatch(/^ {4}SetErrorLevel 2\n/);
    for (const line of check
      .split("\n")
      .filter((l) => l.includes("MB_RETRYCANCEL")))
      expect(line).toContain(
        "Close it (File > Quit) or end it in Task Manager, then press Retry."
      );
  });

  it("speaks of the uninstall in the uninstaller", () => {
    const check = macro("customCheckAppRunning");
    expect(check).toMatch(
      /!ifdef BUILD_UNINSTALLER\n[^!]*Cancel stops the uninstall\.[^!]*!else\n[^!]*Cancel stops the installer\./
    );
    expect(check).toMatch(
      /!ifdef BUILD_UNINSTALLER\n[^!]*then uninstall it again\.[^!]*!else\n[^!]*then run the installer again\./
    );
  });

  it("answers 0 or 2 from PowerShell, and falls back to the process name otherwise", () => {
    const check = macro("EVO_APP_RUNNING");
    expect(check).toContain("{ exit 0 } else { exit 2 }");
    expect(check).toMatch(
      /\$\{If\} \$\{_RETURN\} != 0\n {2}\$\{AndIf\} \$\{_RETURN\} != 2\n {4}nsExec::Exec \/TIMEOUT=30000 `"\$SYSDIR\\cmd\.exe" \/C tasklist \/FI "USERNAME eq %USERNAME%" \/FI "IMAGENAME eq \$\{APP_EXECUTABLE_FILENAME\}"/
    );
    expect(macro("EVO_END_ALL")).toContain("{ exit 0 } else { exit 2 }");
  });
});
