import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Plan, align, assessReadiness, checkArtifacts, redactEvents, renderAll, renderRunbook, renderScript, renderWorkflow,
  runBlocks, sourceTexts, sslRenewEvents, sslRenewPlan, type RenderContext,
} from "../src";

const session = align(redactEvents(sslRenewEvents).events);
const ctx: RenderContext = { sessionId: "ssl-renew", version: 1, sources: sourceTexts(session) };
const clone = <T>(x: T): T => structuredClone(x);

// ---- lint tools: repo .tools/bin first, then PATH -----------------------------------------
const TOOL_DIRS = [join(__dirname, "../../../.tools/bin"), ...(process.env.PATH ?? "").split(delimiter)];
const tool = (name: string) => TOOL_DIRS.map((d) => join(d, name)).find((p) => existsSync(p));
const shellcheck = tool("shellcheck");
const actionlint = tool("actionlint");

describe("render: SSL seed plan", () => {
  const a = renderAll(sslRenewPlan, ctx);

  it("is deterministic", () => {
    expect(renderAll(clone(sslRenewPlan), ctx)).toEqual(a);
  });

  it("produces a strict, sourced script", () => {
    expect(a.script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(a.script).toContain("\nset -euo pipefail\n");
    for (const s of sslRenewPlan.steps) expect(a.script).toContain(`# ── ${s.id} ·`);
    expect(a.script).toContain("[ADDED BY SAYOPS — review]");
    expect(a.script).toContain("N5 “Always test the config before starting, or the whole site goes down.”");
    expect(a.script).toContain("sayops_fail S5 abort_and_rollback");
    expect(a.script).toContain("sayops_exec remote 'sayops_restore /etc/letsencrypt'");
  });

  it("keeps secrets out of flags and recorded values out of commands", () => {
    expect(a.script).not.toContain("--auth-token)");
    expect(a.script).toContain('AUTH_TOKEN="${AUTH_TOKEN:-}"');
    const execLines = a.script.split("\n").filter((l) => /sayops_(exec|check) (local|remote) '/.test(l));
    for (const l of execLines) {
      expect(l).not.toContain("web-1");
      expect(l).not.toContain("shop.example.com");
    }
  });

  it("passes every static check", () => {
    expect(checkArtifacts(sslRenewPlan, a).filter((c) => !c.ok)).toEqual([]);
  });

  it("is valid bash syntax", () => {
    const r = spawnSync("/bin/bash", ["-n"], { input: a.script, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("renders a workflow that never interpolates inputs into run:", () => {
    expect(a.workflow).toContain("workflow_dispatch:");
    expect(a.workflow).toContain("HOST: ${{ inputs.host || vars.SAYOPS_HOST }}");
    expect(a.workflow).toContain("AUTH_TOKEN: ${{ secrets.AUTH_TOKEN }}");
    expect(a.workflow).not.toContain("environment: sayops-approval"); // no HIGH steps
    expect(runBlocks(a.workflow).some((l) => l.includes("${{"))).toBe(false);
  });

  it("renders a runbook with the engineer's reasons", () => {
    expect(a.runbook).toContain("# Runbook: Renew SSL certificate");
    expect(a.runbook).toContain("> “Always test the config before starting, or the whole site goes down.” — N5");
    expect(a.runbook).toContain("SayOps added step **S3**");
    expect(a.runbook).toContain("## Rollback");
  });

  it.skipIf(!shellcheck)("passes shellcheck", () => {
    const r = spawnSync(shellcheck!, ["-"], { input: a.script, encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it.skipIf(!actionlint)("passes actionlint", () => {
    const dir = mkdtempSync(join(tmpdir(), "sayops-wf-"));
    try {
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(join(dir, ".github", "workflows", "renew.yml"), a.workflow);
      const r = spawnSync(actionlint!, [".github/workflows/renew.yml"], { cwd: dir, encoding: "utf8" });
      expect(r.stdout + r.stderr).toBe("");
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

if (!shellcheck || !actionlint) {
  console.warn(`lint tests skipped: ${!shellcheck ? "shellcheck " : ""}${!actionlint ? "actionlint " : ""}not found in .tools/bin or PATH`);
}

// ---- readiness ---------------------------------------------------------------------------
describe("readiness", () => {
  const base = { session, sessionId: "ssl-renew", version: 1 };

  it("needs review until the added backup step is accepted", () => {
    const r = assessReadiness({ ...base, plan: sslRenewPlan });
    expect(r.status).toBe("needs_review");
    expect(r.reviews.map((x) => x.key)).toEqual(["said_not_done:S3"]);
    expect(assessReadiness({ ...base, plan: sslRenewPlan, decisions: { "said_not_done:S3": "accepted" } }).status).toBe("ready");
  });

  it("blocks when the backup is dismissed, because the rollback would restore nothing", () => {
    const r = assessReadiness({ ...base, plan: sslRenewPlan, decisions: { "said_not_done:S3": "dismissed" } });
    expect(r.status).toBe("blocked");
    expect(r.blockers.join()).toContain('no step runs "sayops_backup /etc/letsencrypt"');
    expect(r.plan.steps.some((s) => s.id === "S3")).toBe(false);
    expect(r.artifacts).toBeNull();
  });

  it("blocks an unresolved Said-vs-Did gap", () => {
    const p = clone(sslRenewPlan);
    p.findings[0].fix_step = null;
    const r = assessReadiness({ ...base, plan: p });
    expect(r.status).toBe("blocked");
    expect(r.blockers[0]).toContain("Unresolved said not done");
  });

  it("blocks an unguarded warning", () => {
    const p = clone(sslRenewPlan);
    p.findings.push({ type: "unguarded_warning", detail: "disk may fill up", sources: ["N3"], fix_step: "S2" });
    expect(assessReadiness({ ...base, plan: p, decisions: { "said_not_done:S3": "accepted" } }).status).toBe("blocked");
  });

  it("blocks malformed plans instead of rendering them", () => {
    const bad = [
      { ...clone(sslRenewPlan), steps: [] },
      { ...clone(sslRenewPlan), steps: [{ ...sslRenewPlan.steps[0], sources: ["C99"] }] },
      { ...clone(sslRenewPlan), remote_host: "NOPE" },
      { ...clone(sslRenewPlan), title: "" },
    ] as Plan[];
    for (const plan of bad) {
      const r = assessReadiness({ ...base, plan });
      expect(r.status).toBe("blocked");
      expect(r.artifacts).toBeNull();
      expect(r.blockers.length).toBeGreaterThan(0);
    }
  });
});

// ---- end-to-end: run a generated script against a disposable fixture ----------------------
//
// Same renderer, same runtime as the SSL script, but every path is under a temp directory and
// SAYOPS_TRANSPORT=local runs "remote" steps locally. Nothing touches real infrastructure.

const fixturePlan = Plan.parse({
  title: "Rotate app config",
  remote_host: "HOST",
  params: [
    { name: "HOST", from: "app-1", why: "N1", validate: "^[a-zA-Z0-9.-]+$" },
    { name: "APP_DIR", from: "/srv/app", why: "N1", validate: null },
  ],
  narrations: [{ id: "N1", kind: "condition" }, { id: "N2", kind: "claim" }, { id: "N3", kind: "guard" }, { id: "N4", kind: "rollback" }, { id: "N5", kind: "verify" }],
  steps: [
    {
      id: "S1", intent: "Check the config folder exists", run: 'test -d "$APP_DIR/conf"', remote: true, sources: ["C1"], added: false,
      condition: { skip_if: 'test -f "$APP_DIR/skip-all"', remote: true, scope: "all", why: "N1" }, on_fail: "abort", risk: "LOW",
    },
    { id: "S2", intent: "Back up the config", run: 'sayops_backup "$APP_DIR/conf"', remote: true, sources: ["N2"], added: true, condition: null, on_fail: "abort", risk: "LOW" },
    { id: "S3", intent: "Write the new config", run: "printf 'version=2\\n' > \"$APP_DIR/conf/app.conf\"", remote: true, sources: ["C2"], added: false, condition: null, on_fail: "abort_and_rollback", risk: "LOW" },
    { id: "S4", intent: "Test the config", run: '"$APP_DIR/bin/check-config"', remote: true, sources: ["C3", "N3"], added: false, condition: null, on_fail: "abort_and_rollback", risk: "LOW" },
  ],
  rollback: [{ run: 'sayops_restore "$APP_DIR/conf"', remote: true, why: "N4" }],
  // A health check: true for the old config and the new one, false for a broken one.
  verify: [{ run: 'grep -q "^version=[0-9]" "$APP_DIR/conf/app.conf"', remote: true, why: "N5" }],
  findings: [{ type: "said_not_done", detail: "Backup claimed but not run.", sources: ["N2"], fix_step: "S2" }],
});
const fixtureCtx: RenderContext = { sessionId: "fixture", version: 1, sources: { N3: "Always test the config first." } };

describe("generated script, run against a disposable fixture", () => {
  let root: string;
  let app: string;
  let scriptPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sayops-e2e-"));
    app = join(root, `app dir 'quoted' "x"`); // hostile path: spaces and both quote kinds
    mkdirSync(join(app, "conf"), { recursive: true });
    mkdirSync(join(app, "bin"));
    writeFileSync(join(app, "conf", "app.conf"), "version=1\n");
    writeFileSync(join(app, "check-exit"), "0");
    writeFileSync(join(app, "bin", "check-config"), '#!/bin/sh\nexit "$(cat "$(dirname "$0")/../check-exit")"\n');
    chmodSync(join(app, "bin", "check-config"), 0o755);
    scriptPath = join(root, "rotate.sh");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(plan: Plan, args: string[], env: Record<string, string> = {}) {
    writeFileSync(scriptPath, renderScript(plan, fixtureCtx));
    return spawnSync("/bin/bash", [scriptPath, ...args], {
      encoding: "utf8",
      input: "", // not a TTY: approval prompts must not hang
      env: { PATH: process.env.PATH ?? "", SAYOPS_TRANSPORT: "local", SAYOPS_SUDO: "none", SAYOPS_RUN_ID: "e2e", ...env },
    });
  }
  const conf = () => readFileSync(join(app, "conf", "app.conf"), "utf8");
  const args = () => ["--host", "app-1", "--app-dir", app];

  it("succeeds: backs up, changes, checks and verifies", () => {
    const r = run(fixturePlan, args());
    expect(r.status, r.stderr).toBe(0);
    expect(conf()).toBe("version=2\n");
    expect(readFileSync(join(app, "conf.sayops-bak.e2e", "app.conf"), "utf8")).toBe("version=1\n");
    expect(r.stdout).toContain("sayops: done: Rotate app config");
  });

  it("skips the whole task when the spoken condition is met, touching nothing", () => {
    writeFileSync(join(app, "skip-all"), "");
    const r = run(fixturePlan, args());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to do: condition from N1 is met");
    expect(conf()).toBe("version=1\n");
    expect(existsSync(join(app, "conf.sayops-bak.e2e"))).toBe(false);
  });

  it("rolls back when the config check fails, restoring the original and keeping the failed copy", () => {
    writeFileSync(join(app, "check-exit"), "1");
    const r = run(fixturePlan, args());
    expect(r.status).toBe(5); // failed, rolled back, recovery verified
    expect(r.stderr).toContain("S4 failed (exit 1)");
    expect(r.stderr).toContain("recovery verified: the checks pass after rollback");
    expect(conf()).toBe("version=1\n");
    expect(readFileSync(join(app, "conf.sayops-failed.e2e", "app.conf"), "utf8")).toBe("version=2\n");
    expect(existsSync(join(app, "conf", "conf.sayops-bak.e2e"))).toBe(false); // no copy-into
  });

  it("does not claim recovery when the checks still fail after rollback", () => {
    const p = clone(fixturePlan);
    p.verify = [{ run: 'test -f "$APP_DIR/healthy"', remote: true, why: "N5" }]; // never true here
    const r = run(p, args());
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("verification 1 failed");
    expect(r.stderr).toContain("RECOVERY NOT VERIFIED");
    expect(r.stderr).not.toContain("recovery verified");
    expect(conf()).toBe("version=1\n"); // the rollback itself still ran
  });

  it("does not claim recovery when a rollback command fails", () => {
    writeFileSync(join(app, "check-exit"), "1");
    const p = clone(fixturePlan);
    p.rollback = [{ run: 'sayops_restore "$APP_DIR/missing"', remote: true, why: "N4" }, ...p.rollback];
    const r = run(p, args());
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("ROLLBACK INCOMPLETE");
    expect(r.stderr).toContain("RECOVERY NOT VERIFIED");
  });

  it("does not claim recovery when the plan has no checks", () => {
    writeFileSync(join(app, "check-exit"), "1");
    const r = run({ ...clone(fixturePlan), verify: [] }, args());
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("no verification checks, so recovery cannot be verified");
  });

  it("writes a machine-readable event log and shows each command before running it", () => {
    writeFileSync(join(app, "check-exit"), "1");
    const events = join(root, "events.log");
    const r = run(fixturePlan, args(), { SAYOPS_EVENTS: events });
    expect(r.stdout).toContain(`  $ "$APP_DIR/bin/check-config"`);
    expect(readFileSync(events, "utf8").trim().split("\n")).toEqual([
      "step_start S1", "step_ok S1", "step_start S2", "step_ok S2", "step_start S3", "step_ok S3",
      "step_start S4", "step_fail S4 1", "rollback_start", "rollback_cmd 1 ok", "recovery_check 1 ok", "recovery verified",
    ]);
  });

  it("stops without claiming anything when an abort step fails", () => {
    const r = run(fixturePlan, ["--host", "app-1", "--app-dir", join(root, "nope")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("S1 failed (exit 1); stopping. This step has no rollback, so the system was not checked");
  });

  it("refuses to run with a missing or invalid parameter", () => {
    const missing = run(fixturePlan, ["--host", "app-1"]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("missing required parameter APP_DIR");
    const hostile = run(fixturePlan, ["--host", "-oProxyCommand=x", "--app-dir", app]);
    expect(hostile.status).toBe(2);
    expect(conf()).toBe("version=1\n");
  });

  it("gates HIGH-risk steps behind explicit approval", () => {
    mkdirSync(join(app, "cache"));
    const p = clone(fixturePlan);
    p.steps.push({ id: "S5", intent: "Clear the cache", run: 'rm -rf "$APP_DIR/cache"', remote: true, sources: ["C3"], added: false, condition: null, on_fail: "abort", risk: "HIGH" });
    const denied = run(p, args());
    expect(denied.status).toBe(3);
    expect(denied.stderr).toContain("S5 is HIGH risk and was not approved");
    // refused up front: nothing at all was changed, not even the earlier steps
    expect(existsSync(join(app, "cache"))).toBe(true);
    expect(conf()).toBe("version=1\n");
    expect(existsSync(join(app, "conf.sayops-bak.e2e"))).toBe(false);
    const approved = run(p, args(), { SAYOPS_APPROVED: "1" });
    expect(approved.status, approved.stderr).toBe(0);
    expect(existsSync(join(app, "cache"))).toBe(false);
  });

  it("dry run prints the plan and changes nothing", () => {
    const r = run(fixturePlan, [...args(), "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[dry-run] (remote) sayops_backup \"$APP_DIR/conf\"");
    expect(conf()).toBe("version=1\n");
    expect(existsSync(join(app, "conf.sayops-bak.e2e"))).toBe(false);
  });

  it.skipIf(!shellcheck)("fixture script passes shellcheck too", () => {
    const r = spawnSync(shellcheck!, ["-"], { input: renderScript(fixturePlan, fixtureCtx), encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
  });

  it("marks HIGH plans for environment approval in the workflow", () => {
    const p = clone(fixturePlan);
    p.steps.push({ ...p.steps[0], id: "S5", condition: null, risk: "HIGH" });
    const wf = renderWorkflow(p, fixtureCtx);
    expect(wf).toContain("environment: sayops-approval");
    expect(wf).toContain('SAYOPS_APPROVED: "1"');
    expect(renderRunbook(p, fixtureCtx)).toContain("**Approval required:**");
  });
});
