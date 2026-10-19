#!/usr/bin/env node
// `npm run dev:local`: `next dev` bound to loopback only, with HOSTNAME saying
// so. The settings routes attach EvoScientist's local secret only when
// HOSTNAME is a loopback name, but `next dev` ignores HOSTNAME and listens on
// every interface unless `--hostname` is given. Setting both from one value
// keeps them from disagreeing, which would let the LAN reach those routes.
// Extra arguments pass through: `npm run dev:local -- --port 5150`.

import { spawn } from "child_process";
import { createRequire } from "module";

const LOOPBACK = "127.0.0.1";
const args = process.argv.slice(2);

if (
  args.some(
    (a) => a === "-H" || a === "--hostname" || a.startsWith("--hostname=")
  )
) {
  console.error(
    `dev:local always binds ${LOOPBACK}; drop --hostname, or use npm run dev.`
  );
  process.exit(2);
}

const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(
  process.execPath,
  [
    next,
    "dev",
    "--turbopack",
    "--port",
    "4716",
    "--hostname",
    LOOPBACK,
    ...args,
  ],
  { stdio: "inherit", env: { ...process.env, HOSTNAME: LOOPBACK } }
);

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
