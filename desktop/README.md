# EvoScientist desktop

An Electron app that runs the installed EvoScientist core (`EvoSci deploy --json`) and the bundled WebUI in one window. This folder has the app itself, its unit tests, an unpacked build for manual checks, the Windows installer (NSIS, per user) and the macOS dmg and zip (Apple Silicon; not signed yet).

## Layout

- `src/app.ts`: the main process's state and flows (launch, UI server, restart backend, quit, the end of the session, the status page's actions) behind injected dependencies, testable without Electron.
- `src/main.ts`: builds those dependencies from Electron and wires its events: single instance, window, menu, IPC.
- `src/boot.ts`: the launch sequence (version check; install or repair with the bundled install script, `src/install.ts`; `EvoSci setup`, `src/setup.ts`, or the node stage; workspace; `deploy`), testable without Electron.
- `src/loginPath.ts`: on macOS the packaged app reads the login shell's `PATH` once at startup (an app opened from Finder or the Dock gets launchd's minimal one) and uses it for every child process and to find `EvoSci`. Only `PATH` is taken; when no shell answers within 10 s each, the inherited `PATH` stays. The desktop log names the shell it came from.
- `src/preload.ts`: hands the backend URL to the WebUI before its scripts run; exposes the WebUI's bridge (`window.evoscientistDesktop`: `restartBackend()`, `defaultFolder`, `projectFolders` (the default and launch folders in the core's key form), `pickFolder()`, `appUpdate`) and the status page's bridge (`evoStatus`, with its `update` members).
- `src/appUpdate.ts`: the app's own updates from GitHub Releases (electron-updater), on Windows and on macOS: a check 5 s after start and then hourly, Download only on request, the stall and check limits; `app.ts` runs Restart to update. On macOS it also says where the app cannot be replaced, tells `app.ts` when the system refuses an update, and forgets an install that did not end the app.
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

On a Mac, `npm run dist` builds the dmg to install from and the zip that installed apps update from, for Apple Silicon only, with fixed file names. The build is set up for the hardened runtime with two entitlements files (`assets/mac/entitlements.mac.plist` for the app, `entitlements.mac.inherit.plist` for its helpers), each with the JIT entitlement only. Without a Developer ID certificate the app is not signed: it opens on the Mac that built it, and macOS refuses a copy downloaded in a browser. Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to keep electron-builder from looking in the keychain. A release's app is signed and notarized by the workflow (below); an unsigned or ad-hoc signed build cannot update itself, because macOS checks an update's signature against the running app's.

Logs: `desktop.log` and `desktop-ui.log` next to the backend's `langgraph_dev.log` once `ready` names it (the server home in the data folder, `~/.evoscientist/server` by default; `~/.config/evoscientist` with older cores); before that, in the server home when it holds a backend log, else in `~/.config/evoscientist`. Crash reports `desktop-crash-*.txt` go beside them.

Keep Electron's `RunAsNode` fuse enabled: the UI server runs as the app's own executable with `ELECTRON_RUN_AS_NODE=1` (on macOS as the app's helper executable, so that it gets no Dock icon of its own).

## On macOS

- Closing the window hides it: the app stays in the Dock with its backend and its page, and a click on the Dock icon (or opening the app again) brings the same window back. Quit (⌘Q) runs the checks that closing the window runs on Windows and Linux.
- The packaged app reads the login shell's `PATH` at startup (`src/loginPath.ts`); `npm start` keeps the terminal's. The first screen says "Reading your shell's PATH..." meanwhile. The shell it asks has `EVOSCIENTIST_RESOLVING_ENVIRONMENT=1` set, so a profile can skip a slow or interactive part then, or leave out a daemon it starts. Once the shell has answered, what it started gets a hangup: a job started with `nohup` and its output redirected (`nohup cmd >/dev/null 2>&1 &`) runs on, one that was only disowned (`cmd &!`) ends. The bundled install script runs under `/bin/bash`, whatever that `PATH` has first.
- On its first launch the install script adds uv's tool folder to `PATH` in the shell profile unless it is there already, so `EvoSci` also works in a terminal; the install screen says so.
- A backend or UI server that does not stop in time is ended with everything it started (`killTree` in `src/proc.ts`, on Linux too): the tree is read from `ps` first, because the backend's server runs in a session of its own.
- The app updates itself as on Windows (Download, then Restart to update). The download is the zip; at Restart to update, after the stops, macOS itself fetches it from the app, checks its signature against the running app's, puts the new version in place once the app has quit, and starts it. These differ from Windows:
  - Where the app cannot be replaced, Download and Restart to update only say so, with a button to the releases page: on a read-only volume (the app run from the dmg, or from the random path macOS runs a quarantined app from) and in a folder the account cannot change. The check is whether the bundle and its folder are writable. (Left to itself, macOS asks for an administrator's password in such a folder and answers nothing while that prompt is open.)
  - When macOS refuses the update (a signature it does not accept), the app is back on the current version within seconds instead of after the 15 s wait.
  - When neither an answer nor the app's end came within 15 s, the app is back too, and an answer that comes later no longer quits it. Until macOS has answered, Restart to update says that macOS is still working on the update and stops nothing: macOS takes no second install while one runs. An update macOS finished that late is installed when the app next quits; on Windows nothing is ever installed on quit.
  - A window closed during that wait is hidden, as at any other time, so it is still there when the update is refused and the app comes back. Once the quit itself has begun, the window closes and the app no longer comes back, also when macOS reports an error after that. Should the quit not have ended the app 15 s after it began, the app ends itself (macOS installs the update it holds once the app has ended, and the app is not started again).
- Not there yet: waiting for an `EvoSci update` that is still finishing (`tools/update.lock` is checked on Windows only).

## CI and releases

`.github/workflows/desktop.yml` runs on Windows for pull requests and pushes to `main` (all but docs), weekly and on tags `v*`: lint and unit tests, the build with the installer (so its NSIS script compiles), then `scripts/smoke.mjs` (outside CI only with `--use-my-folders`: it installs and sets up the core in the user's own folders) once per core version (the one the app installs and the newest release inside its range; one run while they are the same). The smoke test installs that core with the bundled install script, runs `EvoSci setup --json --skip webui`, checks `EvoSci --version --json` against the app, starts `EvoSci deploy --json` until `ready`, then the bundled UI server under the packaged `EvoScientist.exe` with `ELECTRON_RUN_AS_NODE=1`, and requests `/` and one static asset.

The same build and smoke test run on macOS (`smoke-macos`, Apple Silicon, unsigned; `npm run dist` there builds the dmg and the zip) for pull requests, pushes to `main` and weekly, and on a tag that releases the macOS files. The unit tests also run on Linux and macOS in `.github/workflows/ci.yml`.

On a tag, while `evoscientist.release` is true (on since the 0.5.1 release, whose core range starts at 0.4.1), the workflow builds the installer with publishing off and fills `release-notes.md` (before any upload, so a template error uploads nothing), in a job without a write token. A job of its own, which holds the token and runs no npm code, then uploads `EvoScientist-Setup.exe` and its blockmap, then `latest.yml`, to the tag's draft release (with a warning if the release was already published by hand) and puts the filled section in place of the notes' `<!-- desktop-release-notes -->` pair if they have one, else below them, reading the notes right before it writes them. The workflow publishes the release after every platform job succeeded, once it has notes of its own in this repository (else the draft stays and the job fails: write the notes, then re-run it), marked Latest unless the current Latest has a higher tag. While the flag is off, the release is published without desktop files. Releases start by pushing the tag, with the notes on a draft made beforehand (`gh release create <tag> --draft --notes-file ...`), or written after a publish job that stopped for them, then that job re-run; publishing is the workflow's last step. A fork's tag build gets its own identity (`W04Test`, its own install folder and userData) and publishes to the fork, for update tests.

The macOS files go out with the Windows ones once `evoscientist.releaseMac` is true as well (off for now; it may be on only while `evoscientist.release` is). On such a tag, after the macOS smoke test on the unsigned build, the `mac` job signs the app with the Developer ID certificate under the hardened runtime, has it notarized and stapled, and checks the result before it hands anything over: the signature, the hardened runtime, the entitlements (the JIT one, none that weakens the runtime), Gatekeeper's verdict (`spctl`) and the notarization ticket (`stapler`), on the app, on the copy in the zip and on the copy in the dmg. It then runs `scripts/smoke.mjs --ui-only` on the signed app (the UI server under the helper) and checks that the bundle's signature still holds. The release job uploads `EvoScientist-arm64.dmg`, `EvoScientist-arm64-mac.zip` and its blockmap with the Windows files, then `latest.yml` and `latest-mac.yml`, and puts both platforms' sections (`release-notes.md`, `release-notes-mac.md`) into the notes. Nothing is uploaded or published unless the `mac` job succeeded. A fork builds the macOS files unsigned, with the `W04Test` identity; such an app cannot update itself.

The signing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY` with the text of the notarization key, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) are read by the `mac` job only, through the environment `release-macos`. That environment is meant to allow only `v*` tags and `main` and to ask a reviewer before each use: a repository secret can be read by a workflow on any branch. In this repository the job fails when a secret is missing. Within the job two steps get them: the check that they are there, which runs nothing else, and the step that signs, which runs electron-builder alone. The dependencies are installed and the app is compiled in steps of their own, without them. The notarization key exists as a file for that step only.

Before the switch goes on, a manual run of the workflow on `main` with `mac_rehearsal` builds this version and the next patch version, both signed and notarized, with the update feed on `http://127.0.0.1:4741/`, and keeps them as the run's artifacts for a day. Nothing is released (on a tag, where a manual run uploads that tag's release, the plan job fails, so no job that builds, uploads or publishes runs). Serving the second build's zip and `latest-mac.yml` on that port lets the first build update to it.
