// The backend's browser boundary (EvoScientist/langgraph_dev/boundary.py).
//
// The backend accepts a browser request only when the page is on a loopback
// name (any port), on an origin listed in `backend_allowed_origins`, or on one
// of the machine's own addresses while the backend listens on the network;
// and only when the request is addressed (`Host`) to one of those names. It
// refuses anything else with a 403 sent before its CORS layer, so the page
// cannot read the refusal: the request fails like an unreachable backend. The
// health light uses this to explain a failure that may be a refusal, instead
// of only asking whether the backend runs. The backend logs every refusal as
// "Refused a request: <reason and fix>".

// The boundary's LOOPBACK_NAMES; the URL API keeps IPv6 brackets in `hostname`.
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
// The backend trusts its own quick tunnel's name (`EvoSci deploy --tunnel`).
// Any such name counts: a quick tunnel gets a new name on every start, so a
// dead one is far likelier than a refusal, and the plain text fits it better.
const QUICK_TUNNEL = /\.trycloudflare\.com$/;
// The backend writes its log to its runtime folder (`DEFAULT_PID_DIR` in
// langgraph_dev/manager.py), which does not follow XDG_CONFIG_HOME.
const BACKEND_LOG = "~/.config/evoscientist/langgraph_dev.log";

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_NAMES.has(hostname.toLowerCase());
}

/** The parts of `window.location` the hint needs. */
export interface PageLocation {
  origin: string;
  hostname: string;
  port: string;
  protocol: string;
}

/**
 * How `GET /info` failed: the request itself was rejected (`network`, which
 * includes a refusal), it ran out of time, or the backend answered an error.
 */
export type OfflineCause = "network" | "timeout" | "http";

// The backend's host name, or null for a URL fetch cannot even send: no
// http(s) scheme (as in a URL typed without one), or credentials in the URL.
function hostnameOf(url: string): string | null {
  try {
    const u = new URL(url);
    const web = u.protocol === "http:" || u.protocol === "https:";
    const usable = web && u.hostname && !u.username && !u.password;
    return usable ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The health light's tooltip when `GET /info` on the backend fails. `page` is
 * `window.location`, or null where there is none (server rendering).
 * `reconnectUrl` is a backend address this page reached instead;
 * `canReconnect` says whether the light shows a Reconnect button for it (it
 * does not on a phone), otherwise the address goes into Settings by hand.
 */
export function offlineTitle(
  deploymentUrl: string,
  page: PageLocation | null,
  cause: OfflineCause | null,
  reconnectUrl: string | null = null,
  canReconnect = true
): string {
  const retry = "Click to retry.";
  const backendHost = hostnameOf(deploymentUrl);
  // This page already got through to a backend there, so nothing needs
  // configuring; unless the saved backend is one the user picked elsewhere,
  // whose own failure the hint below explains.
  const savedOnHand =
    backendHost === null ||
    isLoopbackHost(backendHost) ||
    backendHost === page?.hostname.toLowerCase();
  if (reconnectUrl && savedOnHand) {
    const use = canReconnect
      ? "use Reconnect"
      : "enter it as the Deployment URL in Settings";
    return `Can't reach the backend at ${deploymentUrl}, but one answers at ${reconnectUrl}: ${use}. ${retry}`;
  }
  // Without a Reconnect button, an address that answers is only found here.
  const alternate =
    reconnectUrl && !canReconnect
      ? ` A backend answers at ${reconnectUrl}; enter it as the Deployment URL in Settings to use it.`
      : "";
  const plain = `Can't reach the backend at ${deploymentUrl}. Is "EvoSci deploy" running?${alternate} ${retry}`;
  // A readable error passed CORS, so the backend accepted the page; and the
  // boundary answers at once, so a timeout is not a refusal either.
  if (cause !== "network" || !page || backendHost === null) return plain;

  const pageLocal = isLoopbackHost(page.hostname);
  const backendLocal = isLoopbackHost(backendHost);
  // Any name but a loopback one can be refused on Host: a DNS name, and an
  // address too (the host's address of a backend in a container).
  const hostRefusable = !backendLocal && !QUICK_TUNNEL.test(backendHost);
  if (pageLocal && !hostRefusable) return plain;

  if (backendLocal) {
    // A page off localhost talking to a loopback backend: the backend's
    // machine on a name the boundary does not trust, or another device,
    // whose loopback is itself. Allowing the origin also trusts its host
    // name, which a page opened by name needs from another device.
    return (
      `Can't reach the backend at ${deploymentUrl} from this page, ${page.origin}. ` +
      `If it is running, it refuses pages it does not trust: add ${page.origin} to ` +
      "backend_allowed_origins (comma-separated) in its config.yaml. " +
      `On another device, ${backendHost} is that device itself, so also run ` +
      "`EvoSci config set langgraph_dev_host 0.0.0.0` on the backend's machine. " +
      "Restart the backend after these changes; on another device, then " +
      (canReconnect ? "use Reconnect here once it appears or " : "") +
      "enter the backend machine's address in Settings. " +
      "On the backend's machine, opening the WebUI on localhost usually works without any change. " +
      retry
    );
  }
  const what = [
    hostRefusable && `requests addressed to ${backendHost}`,
    !pageLocal && `${hostRefusable ? "from " : ""}pages on ${page.origin}`,
  ]
    .filter(Boolean)
    .join(" or ");
  return (
    `Can't reach the backend at ${deploymentUrl}. If it is running, it may be refusing ${what}; ` +
    `its log (${BACKEND_LOG}) then shows "Refused a request" with the fix.${alternate} ${retry}`
  );
}

/**
 * Where the backend is when it listens on the network: its port on the host
 * this page came from. Only for a page off localhost (another device, or the
 * machine's LAN address); null otherwise.
 */
export function pageHostBackendUrl(
  page: PageLocation | null,
  backendPort: number | null
): string | null {
  if (!page || backendPort === null || isLoopbackHost(page.hostname))
    return null;
  // An https page can only reach an https backend (mixed content).
  const scheme = page.protocol === "https:" ? "https:" : "http:";
  return `${scheme}//${page.hostname}:${backendPort}`;
}
