// The deployment URL rules shared by the first-run Configuration dialog and
// the Settings page's Connection section.

const INVALID_URL = "Enter a valid URL, e.g. http://127.0.0.1:6174";

/** Why `input` can't be saved as the deployment URL, or null when it can. */
export function deploymentUrlError(input: string): string | null {
  const url = input.trim();
  if (!url) return "Enter your deployment URL to continue.";
  // "http://" or "https://", slashes included: `new URL` also takes any other
  // scheme ("localhost:6174" parses with the protocol "localhost:") and the
  // slash-less "http:/host" or "http:host", which fetch resolves against the
  // page's own address, so where requests land depends on the page.
  if (!/^https?:\/\//i.test(url)) return INVALID_URL;
  // Callers append the API path to the string ("${base}/api/models"), so a
  // query or fragment would swallow it.
  if (/[?#]/.test(url)) return INVALID_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return INVALID_URL;
  }
  // fetch refuses a URL with credentials in it.
  if (parsed.username || parsed.password) return INVALID_URL;
  return null;
}

const comparable = (url: string) => url.trim().replace(/\/$/, "");

/** Whether two addresses name the same deployment as typed: outer spaces
 *  and one trailing slash don't count, so saving them is no backend switch. */
export function sameDeploymentUrl(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}
