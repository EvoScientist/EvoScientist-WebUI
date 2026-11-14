// The release workflow (.github/workflows/desktop.yml) is not run by any
// test. These pin what its jobs may do and when, where a slip would publish
// a release it should not, or hand the signing secrets to code that should
// not have them.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  needs?: string[];
  if?: string;
  env?: Record<string, string>;
  environment?: string;
  permissions?: Record<string, string>;
  concurrency?: { group: string; queue?: string };
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
/** The `${{ }}` expressions in `text`, each without its string literals
 *  ('…'), which may hold `}}` and any word. (A quote inside a string is
 *  written '', which reads the same here as one string ending and the next
 *  beginning.) */
function expressions(text: string): string[] {
  const found: string[] = [];
  let at = text.indexOf("${{");
  while (at !== -1) {
    let code = "";
    let i = at + 3;
    for (; i < text.length; i++) {
      if (text[i] === "'") {
        const close = text.indexOf("'", i + 1);
        i = close === -1 ? text.length : close;
      } else if (text.startsWith("}}", i)) break;
      else code += text[i];
    }
    found.push(code);
    at = text.indexOf("${{", i);
  }
  return found;
}

/** Whether an expression anywhere in `part` reads the secrets context, in
 *  any spelling (`secrets.X`, `secrets['X']`, `toJSON(secrets)`,
 *  `format('{0}', secrets.X)`). */
const namesSecret = (part: unknown) =>
  expressions(JSON.stringify(part)).some((e) => /\bsecrets\b/.test(e));

// The helper itself: a test that cannot see a spelling would pass when a
// secret leaks in it.
describe("namesSecret", () => {
  it("finds the secrets context in any expression, also past a } in a string", () => {
    expect(namesSecret("${{ secrets.CSC_LINK }}")).toBe(true);
    expect(namesSecret("${{ secrets['CSC_LINK'] }}")).toBe(true);
    expect(namesSecret("${{ toJSON(secrets) }}")).toBe(true);
    expect(
      namesSecret("echo ${{ format('{0}', secrets.APPLE_API_KEY) }}")
    ).toBe(true);
    expect(namesSecret("${{ '}}' }} then ${{ secrets.X }}")).toBe(true);
    expect(namesSecret({ env: { K: "${{secrets.X}}" } })).toBe(true);
  });

  it("does not count the word outside an expression or inside a string", () => {
    expect(namesSecret("Check the signing secrets")).toBe(false);
    expect(namesSecret("${{ format('secrets {0}', matrix.build) }}")).toBe(
      false
    );
    expect(namesSecret("${{ 'it''s secrets' }}")).toBe(false);
    expect(namesSecret("${{ matrix.build == 'release' && 'mac' }}")).toBe(
      false
    );
  });
});

describe("the signing secrets", () => {
  it("are read by the mac job only, through its environment", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const text = JSON.stringify(job);
      if (name === "mac") {
        expect(job.environment).toBe("release-macos");
        for (const secret of SECRETS)
          expect(text, secret).toContain(`secrets.${secret}`);
      } else {
        // The npm job's environment names npm's trusted publisher and
        // holds no secret; no other job has one.
        expect(job.environment, name).toBe(name === "npm" ? "npm" : undefined);
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

// npm's trusted publisher for @evoscientist/webui names this workflow file and
// the environment `npm`: the publish job proves with GitHub's OIDC token that
// it is that publisher, so no npm token exists anywhere. The package is built
// in a job of its own, so no dependency code runs next to that token.
describe("the npm jobs", () => {
  const pack = jobs["npm-pack"];
  const npm = jobs.npm;
  const at = (job: Job, re: RegExp) =>
    job.steps.findIndex((s) => re.test(s.run ?? ""));
  const uses = (job: Job, action: string) =>
    job.steps.findIndex((s) => s.uses?.startsWith(action));
  const UPSTREAM_TAG =
    "!cancelled() && startsWith(github.ref, 'refs/tags/v') && ";
  const CHECK = /^node scripts\/npm-release-check\.mjs "\$GITHUB_REF_NAME"$/m;
  const NOT_SKIPPED = "steps.check.outputs.action != 'skip'";

  it("pack only on an upstream tag, after the release is published, and not in a cancelled run", () => {
    expect(pack.needs).toEqual(["publish"]);
    expect(flat(pack.if)).toBe(
      UPSTREAM_TAG +
        "needs.publish.result == 'success' && " +
        "github.repository == 'EvoScientist/EvoScientist-WebUI'"
    );
    expect(npm.needs).toEqual(["npm-pack"]);
    expect(flat(npm.if)).toBe(
      UPSTREAM_TAG +
        "needs.npm-pack.result == 'success' && " +
        "needs.npm-pack.outputs.action != 'skip' && " +
        "github.repository == 'EvoScientist/EvoScientist-WebUI'"
    );
    expect(workflow.env?.UPSTREAM).toBe("EvoScientist/EvoScientist-WebUI");
  });

  // Trusted publishing runs on GitHub's runners only.
  it("run on GitHub's runners, with no secret and no credential kept by the checkout", () => {
    for (const job of [pack, npm]) {
      expect((job as unknown as Record<string, unknown>)["runs-on"]).toBe(
        "ubuntu-latest"
      );
      expect(job.env).toBeUndefined();
      for (const s of job.steps) {
        for (const text of [s.run, s.if, s.with, s.env]) {
          expect(namesSecret(text ?? ""), s.name ?? s.uses).toBe(false);
        }
      }
      const checkout = job.steps[uses(job, "actions/checkout")];
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("build the package without an OIDC token, and publish it with one in the environment npm", () => {
    expect(pack.environment).toBeUndefined();
    expect(pack.permissions).toEqual({ contents: "read" });
    expect(npm.environment).toBe("npm");
    expect(npm.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(workflow.permissions["id-token"]).toBeUndefined();
    for (const [name, job] of Object.entries(jobs)) {
      if (name !== "npm")
        expect(job.permissions?.["id-token"], name).toBeUndefined();
    }
  });

  it("pack after the check, and hand the tarball over", () => {
    const check = at(pack, CHECK);
    expect(check).toBeGreaterThan(-1);
    expect(pack.steps[check].id).toBe("check");
    const ci = at(pack, /^npm ci$/m);
    const packed = at(pack, /^npm pack$/m);
    const upload = uses(pack, "actions/upload-artifact");
    expect(check < ci && ci < packed && packed < upload).toBe(true);
    for (const i of [ci, packed, upload]) {
      expect(pack.steps[i].if).toBe(NOT_SKIPPED);
    }
    expect(pack.steps[upload].with?.name).toBe("npm-package");
    expect(
      (pack as unknown as { outputs: Record<string, string> }).outputs
    ).toEqual({
      action: "${{ steps.check.outputs.action }}",
    });
  });

  // In its own lines the publish job runs npm only to upgrade itself and to
  // publish the tarball; the check script also reads the tarball with
  // `npm pack --dry-run`. None of them runs a package script.
  it("publish the pack job's tarball and run no dependency code", () => {
    const npmLines = runs(npm)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(npm|npx)\s/.test(l));
    expect(npmLines).toEqual([
      "npm install -g npm@11.21.1 --ignore-scripts",
      'npm publish "$1" --provenance --ignore-scripts --loglevel verbose',
    ]);
    expect(runs(npm)).not.toMatch(
      /\bnpm\s+(ci|run|exec|rebuild|install(?!\s+-g\s+npm@))\b|\bnpx\b/
    );
    const check = at(npm, CHECK);
    const upgrade = at(npm, /^npm install -g npm@/m);
    const download = uses(npm, "actions/download-artifact");
    const publish = at(npm, /npm publish/);
    expect(upgrade).toBeLessThan(publish);
    expect(check).toBeLessThan(publish);
    expect(download).toBeLessThan(publish);
    expect(npm.steps[download].with?.name).toBe("npm-package");
    expect(npm.steps[check].id).toBe("check");
    for (const i of [download, publish]) {
      expect(npm.steps[i].if).toBe(NOT_SKIPPED);
    }
  });

  // Trusted publishing needs Node 22.14 and npm 11.5.1 or later.
  it("run a Node and an npm that can publish as a trusted publisher, with no cache", () => {
    for (const job of [pack, npm]) {
      const setup = job.steps[uses(job, "actions/setup-node")];
      expect(Number(setup?.with?.["node-version"])).toBeGreaterThanOrEqual(24);
      expect(setup?.with?.["package-manager-cache"]).toBe(false);
    }
    const setup = npm.steps[uses(npm, "actions/setup-node")];
    expect(setup?.with?.["registry-url"]).toBe("https://registry.npmjs.org");
    const pinned = /npm install -g npm@(\d+)\.(\d+)\.(\d+) /.exec(runs(npm));
    expect(pinned).not.toBeNull();
    const [major, minor, patch] = (pinned ?? []).slice(1).map(Number);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(11005001);
  });

  // Without `queue: max` GitHub cancels a waiting job when another queues.
  it("publish one tag at a time, the others waiting in line", () => {
    expect(npm.concurrency).toEqual({
      group: "${{ github.workflow }}-npm",
      queue: "max",
    });
  });

  // The publish waits for a review, which can take longer than a day.
  it("hand over the tarball by one path", () => {
    const upload = pack.steps[uses(pack, "actions/upload-artifact")];
    expect(upload.with?.path).toBe("*.tgz");
    expect(Number(upload.with?.["retention-days"])).toBeGreaterThanOrEqual(7);
    const download = npm.steps[uses(npm, "actions/download-artifact")];
    expect(download.with?.path).toBe("npm-package");
  });

  // The step's own shell under GitHub's `bash -e`, with stand-ins for the
  // check (`node`) and `npm`: only a check that says publish, read back
  // without an error, publishes, and then the tarball it checked.
  describe.runIf(process.platform !== "win32")(
    "the publish step's shell",
    () => {
      const script = npm.steps[at(npm, /npm publish/)].run ?? "";
      const check =
        "node scripts/npm-release-check.mjs v0.5.4 --tarball npm-package/p.tgz";
      const publish =
        "npm publish npm-package/p.tgz --provenance --ignore-scripts --loglevel verbose";

      /** Runs the step in a folder holding `tarballs`. The check answers
       *  `decision`: "fail" exits 1, "none" writes nothing. */
      function step(
        decision: string,
        { tarballs = ["p.tgz"], catFails = false } = {}
      ) {
        const dir = mkdtempSync(join(tmpdir(), "npm-step-"));
        try {
          const bin = join(dir, "bin");
          mkdirSync(bin);
          mkdirSync(join(dir, "npm-package"));
          for (const t of tarballs) {
            writeFileSync(join(dir, "npm-package", t), "");
          }
          const stub = (name: string, body: string) =>
            writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, {
              mode: 0o755,
            });
          stub(
            "node",
            [
              'echo "node $*" >> "$CALLS"',
              'case "$DECISION" in',
              "  fail) exit 1 ;;",
              "  none) ;;",
              '  *) echo "action=$DECISION" >> "$GITHUB_OUTPUT" ;;',
              "esac",
            ].join("\n")
          );
          stub("npm", 'echo "npm $*" >> "$CALLS"');
          // Prints the decision, then fails as if the read broke off.
          if (catFails) stub("cat", '/bin/cat "$@"\nexit 7');
          const calls = join(dir, "calls");
          writeFileSync(calls, "");
          const r = spawnSync("bash", ["-e", "-c", script], {
            cwd: dir,
            encoding: "utf8",
            env: {
              PATH: `${bin}:/usr/bin:/bin`,
              // The step makes its decision file in here, removed below.
              RUNNER_TEMP: dir,
              CALLS: calls,
              DECISION: decision,
              GITHUB_REF_NAME: "v0.5.4",
              GITHUB_OUTPUT: join(dir, "step-output"),
            },
          });
          const ran = readFileSync(calls, "utf8").split("\n").filter(Boolean);
          return { exit: r.status, ran };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }

      it("publishes the tarball it checked when the check says publish", () => {
        expect(step("publish")).toEqual({ exit: 0, ran: [check, publish] });
      });

      it("ends without publishing when the check says skip", () => {
        expect(step("skip")).toEqual({ exit: 0, ran: [check] });
      });

      it("stops on a failed check, no decision, an unknown one or a failed read", () => {
        for (const decision of ["fail", "none", "maybe"]) {
          expect(step(decision), decision).toEqual({ exit: 1, ran: [check] });
        }
        expect(step("publish", { catFails: true })).toEqual({
          exit: 7,
          ran: [check],
        });
      });

      it("stops before the check without exactly one tarball", () => {
        expect(step("publish", { tarballs: [] })).toEqual({ exit: 1, ran: [] });
        expect(step("publish", { tarballs: ["a.tgz", "b.tgz"] })).toEqual({
          exit: 1,
          ran: [],
        });
      });
    }
  );
});
