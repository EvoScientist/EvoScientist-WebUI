// The release workflow (.github/workflows/desktop.yml) is not run by any
// test. These pin what its jobs may do and when, where a slip would publish
// a release it should not, or hand the signing secrets to code that should
// not have them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

interface Step {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
}
interface Job {
  needs?: string[];
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}

const workflow = load(
  readFileSync(
    join(__dirname, "..", "..", ".github", "workflows", "desktop.yml"),
    "utf8"
  )
) as { permissions: Record<string, string>; jobs: Record<string, Job> };
const jobs = workflow.jobs;
const SECRETS = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
];
/** One line, single spaces: conditions are folded over several. */
const flat = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const runs = (job: Job) => job.steps.map((s) => s.run ?? "").join("\n");

describe("the signing secrets", () => {
  it("are read by the mac job only, through its environment", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const text = JSON.stringify(job);
      if (name === "mac") {
        expect(job.environment).toBe("release-macos");
        for (const secret of SECRETS)
          expect(text, secret).toContain(`secrets.${secret}`);
      } else {
        expect(job.environment, name).toBeUndefined();
        expect(text, name).not.toContain("secrets.");
      }
    }
  });

  it("go to a job without a write token, whose checkout keeps no credential", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(jobs.mac.permissions).toBeUndefined();
    const checkout = jobs.mac.steps.find((s) =>
      s.uses?.startsWith("actions/checkout@")
    ) as Step & { with?: Record<string, unknown> };
    expect(checkout.with?.["persist-credentials"]).toBe(false);
  });

  it("must all be there in the upstream repository, and are never printed", () => {
    const check = jobs.mac.steps.find(
      (s) => s.name === "Check the signing secrets"
    );
    expect(check?.if).toBe("github.repository == env.UPSTREAM");
    for (const secret of SECRETS) expect(check?.run).toContain(secret);
    expect(check?.run).toContain("exit 1");
    // Only names reach the log: no step echoes a secret's variable.
    for (const secret of SECRETS)
      expect(runs(jobs.mac)).not.toMatch(
        new RegExp(`echo[^\\n]*\\$\\{?${secret}\\b`)
      );
  });

  // electron-builder throws when only some of the notarization variables
  // are set, and looks in the keychain when nothing forbids it.
  it("are all unset in a fork's build, which is unsigned", () => {
    const build = jobs.mac.steps.find((s) =>
      s.name?.startsWith("Build, sign and notarize")
    );
    expect(build?.run).toContain(
      "unset CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY_ID APPLE_API_ISSUER"
    );
    expect(build?.run).toContain("export CSC_IDENTITY_AUTO_DISCOVERY=false");
    // The key's path is set for the upstream repository only.
    expect(build?.env?.APPLE_API_KEY).toBeUndefined();
    expect(build?.run).toMatch(
      /if \[ "\$GITHUB_REPOSITORY" = "\$UPSTREAM" \]; then\n\s*export APPLE_API_KEY=/
    );
  });
});

describe("what a tag releases", () => {
  it("builds the macOS files only where the plan says so, after the macOS smoke test", () => {
    expect(jobs.mac.needs).toEqual(["plan", "smoke-macos"]);
    expect(jobs.mac.if).toBe("needs.plan.outputs.mac_builds != '[]'");
    expect(flat(jobs["smoke-macos"].if)).toBe(
      "${{ !startsWith(github.ref, 'refs/tags/') || needs.plan.outputs.mac == 'true' }}"
    );
  });

  // Skipped because its smoke test failed, the mac job must stop the
  // release: a Windows-only release would go out otherwise.
  it("uploads only after the mac job succeeded, unless no macOS files are released", () => {
    expect(jobs.release.needs).toEqual(["plan", "installer", "mac"]);
    expect(flat(jobs.release.if)).toBe(
      "always() && startsWith(github.ref, 'refs/tags/v') && " +
        "needs.installer.result == 'success' && " +
        "(needs.mac.result == 'success' || " +
        "(needs.mac.result == 'skipped' && needs.plan.outputs.mac != 'true'))"
    );
  });

  it("publishes only on a tag, after the Windows smoke test and the upload", () => {
    expect(jobs.publish.needs).toEqual(
      expect.arrayContaining(["smoke", "installer", "release"])
    );
    expect(flat(jobs.publish.if)).toBe(
      "always() && startsWith(github.ref, 'refs/tags/v') && " +
        "needs.smoke.result == 'success' && " +
        "(needs.release.result == 'success' || needs.installer.result == 'skipped')"
    );
  });

  it("uploads what apps read to find an update after the files it names", () => {
    const upload = jobs.release.steps.find((s) =>
      s.name?.startsWith("Upload the apps")
    );
    const lines = (upload?.run ?? "")
      .split("\n")
      .filter((l) => l.includes("gh release upload"))
      .map((l) => l.trim());
    const at = (file: string) => lines.findIndex((l) => l.includes(file));
    expect(lines).toHaveLength(4);
    expect(at("latest.yml")).toBeGreaterThan(at("EvoScientist-Setup.exe "));
    expect(at("latest.yml")).toBeGreaterThan(at("EvoScientist-arm64-mac.zip "));
    expect(at("latest-mac.yml")).toBe(3);
  });

  it("keeps the write token away from npm code", () => {
    for (const name of ["release", "publish"]) {
      expect(jobs[name].permissions, name).toEqual({ contents: "write" });
      expect(runs(jobs[name]), name).not.toMatch(/\bnpm\b|\bnpx\b/);
    }
  });
});

describe("the manual rehearsal", () => {
  it("builds two versions in the upstream repository only, and reaches no release", () => {
    const plan = runs(jobs.plan);
    expect(plan).toContain(
      `if [ "$REHEARSAL" = true ] && [ "$fork" = false ]; then`
    );
    expect(plan).toContain(`builds='["rehearsal","rehearsal-next"]'`);
    for (const name of ["release", "publish"])
      expect(flat(jobs[name].if), name).toContain(
        "startsWith(github.ref, 'refs/tags/v')"
      );
  });

  it("gives both builds a feed on this machine, and the second the next patch version", () => {
    const step = jobs.mac.steps.find((s) => s.name?.startsWith("Rehearsal"));
    expect(step?.if).toBe("startsWith(matrix.build, 'rehearsal')");
    expect(step?.run).toContain(
      "pkg.build.publish = { provider: 'generic', url: 'http://127.0.0.1:4741/' };"
    );
    expect(step?.run).toMatch(
      /if \[ "\$BUILD" = rehearsal-next \]; then\n\s*npm version patch --no-git-tag-version/
    );
  });
});
