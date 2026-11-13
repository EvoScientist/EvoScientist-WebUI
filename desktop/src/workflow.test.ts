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
  env?: Record<string, string>;
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}

// A Windows checkout has CRLF line ends.
const workflow = load(
  readFileSync(
    join(__dirname, "..", "..", ".github", "workflows", "desktop.yml"),
    "utf8"
  ).replace(/\r\n/g, "\n")
) as {
  permissions: Record<string, string>;
  env?: Record<string, string>;
  concurrency: { group: string };
  jobs: Record<string, Job>;
};
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
/** Whether an expression anywhere in `part` reads the secrets context, in
 *  any spelling (`secrets.X`, `secrets['X']`, `toJSON(secrets)`). */
const namesSecret = (part: unknown) =>
  (JSON.stringify(part).match(/\$\{\{[^}]*\}\}/g) ?? []).some((e) =>
    /\bsecrets\b/.test(e)
  );

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
        expect(namesSecret(job), name).toBe(false);
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

  it("must all be there in the upstream repository", () => {
    const check = jobs.mac.steps.find(
      (s) => s.name === "Check the signing secrets"
    );
    expect(check?.if).toBe("github.repository == env.UPSTREAM");
    for (const secret of SECRETS) expect(check?.run).toContain(secret);
    expect(check?.run).toContain("exit 1");
  });

  // A secret's value is read in two places only: the check whether it is
  // empty, and the line that writes the notarization key to its file. That
  // file is named only where it is written and where its path is exported.
  // Everything else in the job's scripts handles names.
  it("have their values read by no other line of the job's scripts", () => {
    const lines = runs(jobs.mac)
      .split("\n")
      .map((l) => l.trim());
    const reads = new RegExp(
      `\\$\\{?!?(APPLE_API_KEY_P8|${SECRETS.join("|")}|name)\\b|\\$\\{!`
    );
    const writesKey = `(umask 077 && printf '%s\\n' "$APPLE_API_KEY_P8" > "$RUNNER_TEMP/notary-key.p8")`;
    expect(lines.filter((l) => reads.test(l))).toEqual([
      `[ -n "\${!name}" ] || missing+=("$name")`,
      writesKey,
    ]);
    // The removal is set up before the file is written.
    expect(lines.filter((l) => l.includes("notary-key.p8"))).toEqual([
      `trap 'rm -f "$RUNNER_TEMP/notary-key.p8"' EXIT`,
      writesKey,
      `export APPLE_API_KEY="$RUNNER_TEMP/notary-key.p8"`,
    ]);
  });

  // The WebUI's build and both `npm ci` run every dependency's code and
  // need no secret.
  it("reach the step that signs only, after the dependencies were installed", () => {
    const steps = jobs.mac.steps;
    const SIGN = "Build, sign and notarize the app (publishing off)";
    // Two steps name them: the check that they are there, which runs
    // nothing else, and the step that signs. Not the job's or the
    // workflow's own environment, which every step would get.
    // (Anywhere in the step: its `env`, but also an action's `with`.)
    expect(steps.filter((s) => namesSecret(s)).map((s) => s.name)).toEqual([
      "Check the signing secrets",
      SIGN,
    ]);
    for (const s of steps.filter((x) => x.uses))
      expect(namesSecret(s), s.uses).toBe(false);
    // Nowhere else in the job (its `env`, its outputs, ...) nor in the
    // workflow's own `env`.
    const rest = {
      ...jobs.mac,
      steps: steps.filter(
        (s) => s.name !== "Check the signing secrets" && s.name !== SIGN
      ),
    };
    expect(namesSecret(rest)).toBe(false);
    expect(namesSecret(workflow.env ?? {})).toBe(false);
    expect(
      steps.find((s) => s.name === "Check the signing secrets")?.run
    ).not.toMatch(/\b(npm|npx|node)\b/);
    const names = steps.map((s) => s.name);
    const BEFORE = [
      "Build the WebUI",
      "Install the desktop dependencies",
      "Compile and fetch the core's install scripts",
    ];
    for (const before of BEFORE) {
      expect(names.indexOf(before), before).toBeGreaterThan(-1);
      expect(names.indexOf(before), before).toBeLessThan(names.indexOf(SIGN));
    }
    // The step that signs runs electron-builder and nothing of npm: what
    // `npm run dist` does before it packages ran in the step before.
    const sign = steps.find((s) => s.name === SIGN);
    expect(sign?.run).not.toMatch(/\bnpm\b|\bnpx\b/);
    expect(sign?.run).toContain(
      `node scripts/builder.mjs --publish never "\${args[@]}"`
    );
    expect(steps.find((s) => s.name === BEFORE[2])?.run).toBe(
      "npm run fetch-core-scripts"
    );
    const scripts = (
      JSON.parse(
        readFileSync(join(__dirname, "..", "package.json"), "utf8")
      ) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts.dist).toBe(
      "npm run fetch-core-scripts && node scripts/builder.mjs --publish never"
    );
    // The key file's permissions are set in a subshell: a umask for the
    // whole step would reach the app's own files.
    expect(sign?.run).not.toMatch(/^\s*umask /m);
  });

  // electron-builder throws when only some of the notarization variables
  // are set, and looks in the keychain when nothing forbids it.
  it("are all unset in a fork's build, which is unsigned", () => {
    const build = jobs.mac.steps.find((s) =>
      s.name?.startsWith("Build, sign and notarize")
    );
    expect(build?.run).toContain(
      "unset CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER"
    );
    expect(build?.run).toContain("export CSC_IDENTITY_AUTO_DISCOVERY=false");
    // The key's path is set for the upstream repository only.
    expect(build?.env?.APPLE_API_KEY).toBeUndefined();
    // Upstream branch: the key's path in, the key's text out. Fork branch
    // (after `else`): neither.
    const [upstream, fork] = (build?.run ?? "").split(/^\s*else$/m);
    expect(upstream).toMatch(
      /^args=\(\)\nif \[ "\$GITHUB_REPOSITORY" = "\$UPSTREAM" \]; then\n/
    );
    expect(upstream).toMatch(
      /export APPLE_API_KEY="\$RUNNER_TEMP\/notary-key\.p8"\n\s*unset APPLE_API_KEY_P8\n$/
    );
    expect(fork).not.toContain("export APPLE_API_KEY=");
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
      "!cancelled() && startsWith(github.ref, 'refs/tags/v') && " +
        "needs.installer.result == 'success' && " +
        "(needs.mac.result == 'success' || " +
        "(needs.mac.result == 'skipped' && needs.plan.outputs.mac != 'true'))"
    );
  });

  it("publishes only on a tag, after the Windows smoke test and the upload, and not in a cancelled run", () => {
    expect(jobs.publish.needs).toEqual(
      expect.arrayContaining(["smoke", "installer", "release"])
    );
    expect(flat(jobs.publish.if)).toBe(
      "!cancelled() && startsWith(github.ref, 'refs/tags/v') && " +
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
  // Any other manual run on a tag uploads that tag's release, as the tag's
  // push does: the two must queue, or their uploads could interleave.
  it("is the only run with a concurrency group of its own", () => {
    expect(workflow.concurrency.group).toBe(
      "${{ github.workflow }}-${{ github.ref }}${{ github.event_name == 'workflow_dispatch' && inputs.mac_rehearsal && '-rehearsal' || '' }}"
    );
  });

  // A manual run on a tag uploads and publishes that tag's release, as a
  // push of the tag does.
  it("fails at once on a tag, before anything is planned", () => {
    const plan = runs(jobs.plan);
    const refusal = plan.indexOf(
      `if [ "$REHEARSAL" = true ] && [[ "$GITHUB_REF" == refs/tags/* ]]; then`
    );
    expect(refusal).toBeGreaterThan(-1);
    expect(plan.slice(refusal, refusal + 300)).toMatch(
      /^[^\n]*\n\s*echo "::error::[^\n]*\n\s*exit 1\n/
    );
    expect(refusal).toBeLessThan(plan.indexOf("GITHUB_OUTPUT"));
    // Every job that builds or uploads waits for the plan.
    for (const name of ["smoke", "smoke-macos", "installer", "mac", "release"])
      expect(jobs[name].needs, name).toContain("plan");
  });

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
