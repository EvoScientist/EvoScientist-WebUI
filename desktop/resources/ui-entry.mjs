// The UI server's entry script. The app starts it as its own executable with
// ELECTRON_RUN_AS_NODE=1 (Electron's Node, no second Node shipped), three
// pipes and an IPC channel. It loads the bundled WebUI's `server.js` (an ES
// module that changes into its own folder and listens on HOSTNAME:PORT), and
// exits when its stdin closes or the app's IPC channel disconnects, so an app
// that crashed leaves no UI server behind.
import { pathToFileURL } from "node:url";

const serverJs = process.env.EVOSCIENTIST_UI_SERVER_JS;
if (!serverJs) {
  console.error("EVOSCIENTIST_UI_SERVER_JS is not set");
  process.exit(2);
}

process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdin.resume();
process.on("disconnect", () => process.exit(0));

try {
  await import(pathToFileURL(serverJs).href);
} catch (e) {
  console.error(`cannot load ${serverJs}: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
}
