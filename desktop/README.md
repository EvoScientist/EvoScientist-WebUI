# EvoScientist desktop

An Electron app that runs the installed EvoScientist core (`EvoSci deploy --json`) and the bundled WebUI in one window. The installer, signing and updates come later (W04); this folder has the app itself, its unit tests and an unpacked build for manual checks.

## Layout

- `src/main.ts`: app lifecycle, single instance, window, menu, close flow.
- `src/boot.ts`: the launch sequence (version check, node stage, workspace, `deploy`), testable without Electron.
- `src/preload.ts`: hands the backend URL to the WebUI before its scripts run; the status page's bridge.
- `resources/status.html`: the static status and error page, shown until the UI server answers. It never calls the backend.
- `resources/ui-entry.mjs`: starts the bundled WebUI server (`dist/server.js` from the root build) with Electron's own Node.

## Develop

```
npm ci
npx --no install-electron   # Electron 44 downloads its binary only on demand
npm run lint
npm test
```

`npm start` builds the main process and opens the app. It serves the WebUI from the repository's own `dist/`, so run `npm run build` at the repository root first.

## Unpacked build (manual checks)

```
# repository root
npm ci
npm run build
# desktop/
npm ci
npm run pack
```

The app is in `release/win-unpacked/EvoScientist.exe` (`linux-unpacked`, `mac` on other platforms). The bundled WebUI is in `resources/ui/`.

Logs: `desktop.log` and `desktop-ui.log` next to the backend's `langgraph_dev.log` (`~/.config/evoscientist` until the core moves its runtime files), with crash reports `desktop-crash-*.txt` beside them.

Keep Electron's `RunAsNode` fuse enabled: the UI server runs as the app's own executable with `ELECTRON_RUN_AS_NODE=1`.
