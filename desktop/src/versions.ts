// Release numbers and PEP 440 ranges of `>=`, `>`, `<=`, `<` and `==`
// clauses, the form of the core's `webui_compat` (">=0.3,<0.5") and of the
// app's own core range. Only plain release numbers match: a pre-release, a
// post-release or a local version never does, as the core skips them for
// WebUI releases. Node's `semver` cannot read the comma form.

export type Release = number[];

const RELEASE = /^\d+(\.\d+)*$/;
const CLAUSE = /^(>=|<=|==|>|<)\s*(\d+(?:\.\d+)*)$/;

/** The release number of a version, or null when it is anything else. */
export function parseRelease(version: string): Release | null {
  const text = version.trim();
  if (!RELEASE.test(text)) return null;
  return text.split(".").map(Number);
}

/** Compares two release numbers, padding the shorter with zeros. */
export function compareReleases(a: Release, b: Release): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type Clause = { op: ">=" | "<=" | "==" | ">" | "<"; release: Release };

/** The clauses of a range, or null when any clause is not of the form above. */
export function parseRange(range: string): Clause[] | null {
  const parts = range.split(",").map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => !p)) return null;
  const clauses: Clause[] = [];
  for (const part of parts) {
    const m = CLAUSE.exec(part);
    if (!m) return null;
    clauses.push({
      op: m[1] as Clause["op"],
      release: m[2].split(".").map(Number),
    });
  }
  return clauses;
}

function holds(clause: Clause, release: Release): boolean {
  const c = compareReleases(release, clause.release);
  switch (clause.op) {
    case ">=":
      return c >= 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case "<":
      return c < 0;
    case "==":
      return c === 0;
  }
}

/**
 * Where a version sits against a range: inside it, below a lower bound,
 * above an upper bound, or not comparable (not a release number, or a range
 * this parser does not read). A failed `==` counts as below or above by order.
 */
export type Placement = "inside" | "below" | "above" | "invalid";

export function placeInRange(version: string, range: string): Placement {
  const release = parseRelease(version);
  const clauses = parseRange(range);
  if (!release || !clauses) return "invalid";
  for (const clause of clauses) {
    if (holds(clause, release)) continue;
    if (clause.op === ">=" || clause.op === ">") return "below";
    if (clause.op === "<=" || clause.op === "<") return "above";
    return compareReleases(release, clause.release) < 0 ? "below" : "above";
  }
  return "inside";
}

export function inRange(version: string, range: string): boolean {
  return placeInRange(version, range) === "inside";
}
