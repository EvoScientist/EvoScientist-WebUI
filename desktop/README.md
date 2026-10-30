# EvoScientist desktop

An Electron app that runs the installed EvoScientist core (`EvoSci deploy --json`) and the bundled WebUI in one window. This folder has the app itself, its unit tests, an unpacked build for manual checks and the Windows installer (NSIS, per user).

## Layout

- `src/app.ts`: the main process's state and flows (launch, UI server, restart backend, quit, the end of the session, the status page's actions) behind injected dependencies, testable without Electron.
- `src/main.ts`: builds those dependencies from Electron and wires its events: single instance, window, menu, IPC.
- `src/boot.ts`: the launch sequence (version check; install or repair with the bundled install script, `src/install.ts`; `EvoSci setup`, `src/setup.ts`, or the node stage; workspace; `deploy`), testable without Electron.
- `src/preload.ts`: hands the backend URL to the WebUI before its scripts run; exposes the WebUI's bridge (`window.evoscientistDesktop`: `restartBackend()`, `defaultFolder`) and the status page's bridge.
- `resources/status.html`: the static status and error page, shown until the UI server answers. It never calls the backend.
- `resources/ui-entry.mjs`: starts the bundled WebUI server (`dist/server.js` from the root build) with Electron's own Node.
- `src/packaging.ts` + `scripts/builder.mjs`: run electron-builder with the app's version taken from the root `package.json` (the WebUI version it bundles; `desktop/package.json`'s own version is never used), and refuse `evoscientist.release` while the core range installs a core before 0.4.0.
- `installer/check-app-running.nsh`: before the installer or the uninstaller replaces files, it asks a running app to quit through its own quit (`EvoScientist.exe --quit-for-install`, busy question included) and stops when the user cancels; once the app is gone it ends a UI server left running on its own. electron-builder's own check would end the app's backend and its running work at once.
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
```

`npm run pack` downloads the core's install scripts first (`npm run fetch-core-scripts`, which `npm start` needs too before it can install or repair the core); it needs Node 24.5 or newer (`node --use-env-proxy`); behind a proxy, set `HTTPS_PROXY`. The app is in `release/win-unpacked/EvoScientist.exe` (`linux-unpacked`, `mac` on other platforms). The bundled WebUI is in `resources/ui/`. `npm run dist` builds the installer with publishing off; it needs Windows (on Linux electron-builder needs Wine). The installer installs per user into `%LOCALAPPDATA%\Programs\EvoScientist` without an administrator prompt. Never change `build.appId` or `build.extraMetadata.name` after the first release: upgrades, uninstall and the install folder depend on them.

Logs: `desktop.log` and `desktop-ui.log` next to the backend's `langgraph_dev.log` (`~/.config/evoscientist` until the core moves its runtime files), with crash reports `desktop-crash-*.txt` beside them.

Keep Electron's `RunAsNode` fuse enabled: the UI server runs as the app's own executable with `ELECTRON_RUN_AS_NODE=1`.

## CI and releases

`.github/workflows/desktop.yml` runs on Windows for pull requests (all but docs), weekly and on tags `v*`: lint and unit tests, an unpacked build, then `scripts/smoke.mjs` once per core version (the one the app installs and the newest release inside its range; one run while they are the same). The smoke test installs that core with the bundled install script, runs `EvoSci setup --json --skip webui`, checks `EvoSci --version --json` against the app, starts `EvoSci deploy --json` until `ready`, then the bundled UI server under the packaged `EvoScientist.exe` with `ELECTRON_RUN_AS_NODE=1`, and requests `/` and one static asset.

On a tag, once `evoscientist.release` is true (the pull request that moves the core range to a release from 0.4.0 sets it), the workflow builds the installer with publishing off, uploads `EvoScientist-Setup.exe` and its blockmap, then `latest.yml`, to the tag's draft release, adds the filled `release-notes.md` below the notes there, and publishes the release after every platform job succeeded. While the flag is off, the release is published without desktop files. Releases start by pushing the tag; publishing is the workflow's last step. A fork's tag build gets its own identity (`W04Test`, its own install folder and userData) and publishes to the fork, for update tests.
