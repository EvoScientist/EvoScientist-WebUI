// The marker of a WebUI server that listens exactly on `HOSTNAME`. The
// settings routes attach EvoScientist's local secret only when `HOSTNAME` is
// a loopback name, which proves the bind only for a server that honours it:
// the standalone `dist/server.js` (the bin and `EvoSci --ui webui` run it)
// and `npm run dev:local`. Plain `next dev` and `next start` ignore
// `HOSTNAME` and listen on every interface, so they never carry the marker.

export const BIND_MARKER = "EVOSCIENTIST_WEBUI_BINDS_HOSTNAME";

/** The standalone server's source with the marker set at its top. Throws
 *  when the source no longer binds `HOSTNAME` (a Next.js change), so the
 *  build fails instead of shipping a marker that would lie. */
export function markStandaloneServer(source) {
  if (source.includes(`process.env.${BIND_MARKER}`)) return source;
  if (!/const hostname = process\.env\.HOSTNAME\b/.test(source)) {
    throw new Error(
      "server.js no longer binds process.env.HOSTNAME; the settings routes' loopback check needs a new signal"
    );
  }
  return `process.env.${BIND_MARKER} = "1"\n${source}`;
}
