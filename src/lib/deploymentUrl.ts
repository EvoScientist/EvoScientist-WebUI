// The deployment URL rules shared by the first-run Configuration dialog and
// the Settings page's Connection section.

/** Why `input` can't be saved as the deployment URL, or null when it can. */
export function deploymentUrlError(input: string): string | null {
  const url = input.trim();
  if (!url) return "Enter your deployment URL to continue.";
  try {
    new URL(url);
  } catch {
    return "Enter a valid URL, e.g. http://127.0.0.1:6174";
  }
  return null;
}

const comparable = (url: string) => url.trim().replace(/\/$/, "");

/** Whether two addresses name the same deployment as typed: outer spaces
 *  and one trailing slash don't count, so saving them is no backend switch. */
export function sameDeploymentUrl(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}
