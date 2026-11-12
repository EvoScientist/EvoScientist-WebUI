# EvoScientist desktop

An Electron app that runs the installed EvoScientist core (`EvoSci deploy --json`) and the bundled WebUI in one window. This folder has the app itself, its unit tests, an unpacked build for manual checks, the Windows installer (NSIS, per user) and the macOS dmg and zip (Apple Silicon; not signed yet).

## Layout

- `src/app.ts`: the main process's state and flows (launch, UI server, restart backend, quit, the end of the session, the status page's actions) behind injected dependencies, testable without Electron.
- `src/main.ts`: builds those dependencies from Electron and wires its events: single instance, window, menu, IPC.
- `src/boot.ts`: the launch sequence (version check; install or repair with the bundled install script, `src/install.ts`; `EvoSci setup`, `src/setup.ts`, or the node stage; workspace; `deploy`), testable without Electron.
- `src/loginPath.ts`: on macOS the packaged app reads the login shell's `PATH` once at startup (an app opened from Finder or the Dock gets launchd's minimal one) and uses it for every child process and to find `EvoSci`. Only `PATH` is taken; when no shell answers within 10 s each, the inherited `PATH` stays. The desktop log names the shell it came from.
- `src/preload.ts`: hands the backend URL to the WebUI before its scripts run; exposes the WebUI's bridge (`window.evoscientistDesktop`: `restartBackend()`, `defaultFolder`, `projectFolders` (the default and launch folders in the core's key form), `pickFolder()`, `appUpdate`) and the status page's bridge (`evoStatus`, with its `update` members).
- `src/appUpdate.ts`: the app's own updates from GitHub Releases (electron-updater): a check 5 s after start and then hourly, Download only on request, the stall and check limits; `app.ts` runs Restart to update.
- `resources/status.html`: the static status and error page, shown until the UI server answers. It never calls the backend.
- `resources/ui-entry.mjs`: starts the bundled WebUI server (`dist/server.js` from the root build) with Electron's own Node.
- `src/packaging.ts` + `scripts/builder.mjs`: run electron-builder with the app's version taken from the root `package.json` (the WebUI version it bundles; `desktop/package.json`'s own version is never used), and refuse `evoscientist.release` while the core range installs a core before 0.4.1 (the first with the Windows clean stop, EvoScientist#716).
- `installer/check-app-running.nsh`: before the installer or the uninstaller replaces files, it asks a running app to quit through its own quit (`EvoScientist.exe --quit-for-install`, busy question included) and stops when the user cancels; once the app is gone it ends a UI server left running on its own. electron-builder's own check would end the app's backend and its running work at once.
- `assets/mac/`: the macOS app icon (`EvoScientist.icns`), the picture it is drawn from (`robot.png`) and `make-icon.sh`, which rebuilds it on a Mac. The icon is named in `build.mac.icon` and kept out of electron-builder's default icon locations (`build/`, `icon.*`, `icons/`), where it would also become the Windows installer's icon.
- `scripts/fetch-core-scripts.mjs`: downloads the core's `install.ps1` and `install.sh` from the tag of the version the app installs (the lower bound of `evoscientist.coreRange`) into `core-scripts/`; `scripts/before-pack.cjs` refuses to package without them.

## Develop

```
npm ci
npx --no install-electron   # Electron 44 downloads its binary only on demand
npm run lint
npm test
```

`npm start` builds the main process and opens the app. It serves the WebUI from the repository's own `dist/`, so run `npm run build` at the repository root first.

## Builds

```
# repository root
npm ci
npm run build
# desktop/
npm ci
npm run pack   # unpacked
npm run dist   # Windows: release/EvoScientist-Setup.exe, its blockmap and latest.yml
               # macOS: release/EvoScientist-arm64.dmg, EvoScientist-arm64-mac.zip, its blockmap and latest-mac.yml
```

`npm run pack` downloads the core's install scripts first (`npm run fetch-core-scripts`, which `npm start` needs too before it can install or repair the core); it needs Node 24.5 or newer (`node --use-env-proxy`); behind a proxy, set `HTTPS_PROXY`. The app is in `release/win-unpacked/EvoScientist.exe` (`release/mac-arm64/EvoScientist.app` on macOS, `linux-unpacked` on Linux). The bundled WebUI is in `resources/ui/` (`Contents/Resources/ui/` in the macOS app). `npm run dist` builds the installer with publishing off; the Windows installer needs Windows (on Linux electron-builder needs Wine). The installer installs per user into `%LOCALAPPDATA%\Programs\EvoScientist` without an administrator prompt. Never change `build.appId` or `build.extraMetadata.name` after the first release: upgrades, uninstall and the install folder depend on them.

On a Mac, `npm run dist` builds the dmg to install from and the zip that updates will use, for Apple Silicon only, with fixed file names. Without a Developer ID certificate in the keychain the app is not signed: it opens on the Mac that built it, and macOS refuses a copy downloaded in a browser. Signing, notarization and releases of the macOS files come with the second part of #60.

Logs: `desktop.log` and `desktop-ui.log` next to the backend's `langgraph_dev.log` once `ready` names it (the server home in the data folder, `~/.evoscientist/server` by default; `~/.config/evoscientist` with older cores); before that, in the server home when it holds a backend log, else in `~/.config/evoscientist`. Crash reports `desktop-crash-*.txt` go beside them.

Keep Electron's `RunAsNode` fuse enabled: the UI server runs as the app's own executable with `ELECTRON_RUN_AS_NODE=1` (on macOS as the app's helper executable, so that it gets no Dock icon of its own).

## On macOS

- Closing the window hides it: the app stays in the Dock with its backend and its page, and a click on the Dock icon (or opening the app again) brings the same window back. Quit (⌘Q) runs the checks that closing the window runs on Windows and Linux.
- The packaged app reads the login shell's `PATH` at startup (`src/loginPath.ts`); `npm start` keeps the terminal's. The shell it asks has `EVOSCIENTIST_RESOLVING_ENVIRONMENT=1` set, so a profile can skip a slow or interactive part then, or leave out a daemon it starts. Once the shell has answered, what it started gets a hangup: a job started with `nohup` runs on, one that was only disowned (`cmd &!`) ends; the first screen says "Reading your shell's PATH..." meanwhile. The bundled install script runs under `/bin/bash`, whatever that `PATH` has first.
- On its first launch the install script adds uv's tool folder to `PATH` in the shell profile unless it is there already, so `EvoSci` also works in a terminal; the install screen says so.
- A backend or UI server that does not stop in time is ended with everything it started (`killTree` in `src/proc.ts`, on Linux too): the tree is read from `ps` first, because the backend's server runs in a session of its own.
- Not there yet: signing and notarization, releases of the macOS files, the app's own updates, and waiting for an `EvoSci update` that is still finishing (`tools/update.lock` is checked on Windows only).

## CI and releases

`.github/workflows/desktop.yml` runs on Windows for pull requests and pushes to `main` (all but docs), weekly and on tags `v*`: lint and unit tests, the build with the installer (so its NSIS script compiles), then `scripts/smoke.mjs` (outside CI only with `--use-my-folders`: it installs and sets up the core in the user's own folders) once per core version (the one the app installs and the newest release inside its range; one run while they are the same). The smoke test installs that core with the bundled install script, runs `EvoSci setup --json --skip webui`, checks `EvoSci --version --json` against the app, starts `EvoSci deploy --json` until `ready`, then the bundled UI server under the packaged `EvoScientist.exe` with `ELECTRON_RUN_AS_NODE=1`, and requests `/` and one static asset.

The same build and smoke test run on macOS (`smoke-macos`, Apple Silicon, unsigned; `npm run dist` there builds the dmg and the zip) for pull requests, pushes to `main` and weekly, but not on tags: no macOS file is released yet, and the publish job does not wait for it. The unit tests also run on Linux and macOS in `.github/workflows/ci.yml`.

On a tag, while `evoscientist.release` is true (on since the 0.5.1 release, whose core range starts at 0.4.1), the workflow builds the installer with publishing off and fills `release-notes.md` (before any upload, so a template error uploads nothing), in a job without a write token. A job of its own, which holds the token and runs no npm code, then uploads `EvoScientist-Setup.exe` and its blockmap, then `latest.yml`, to the tag's draft release (with a warning if the release was already published by hand) and puts the filled section in place of the notes' `<!-- desktop-release-notes -->` pair if they have one, else below them, reading the notes right before it writes them. The workflow publishes the release after every platform job succeeded, once it has notes of its own in this repository (else the draft stays and the job fails: write the notes, then re-run it), marked Latest unless the current Latest has a higher tag. While the flag is off, the release is published without desktop files. Releases start by pushing the tag, with the notes on a draft made beforehand (`gh release create <tag> --draft --notes-file ...`), or written after a publish job that stopped for them, then that job re-run; publishing is the workflow's last step. A fork's tag build gets its own identity (`W04Test`, its own install folder and userData) and publishes to the fork, for update tests.
