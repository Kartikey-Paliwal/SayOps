import { describe, expect, it } from "vitest";
import {
  align, assessReadiness, compile, findGaps, parseRun, redactEvents, sslRenewEvents, sslRenewPlan, sslRenewProof,
  type JsonLlm, type Plan, type SessionEvent,
} from "../src";

describe("parseRun", () => {
  const output = [
    "sayops: Renew SSL certificate — run x",
    "sayops: S1 · Check when the certificate expires",
    "  $ sudo certbot certificates -d \"$DOMAIN\"",
    "sayops: S1 ok",
    "sayops: S5 · Test the nginx config before starting",
    "  $ sudo nginx -t",
    "nginx: configuration file /etc/nginx/nginx.conf test failed",
    "sayops: S5 failed (exit 1)",
    "sayops: rolling back",
    "  $ sayops_restore /etc/letsencrypt",
    "sayops: recovery verified: the checks pass after rollback (the task itself did not complete)",
  ].join("\n");
  const events = ["step_start S1", "step_ok S1", "step_start S5", "step_fail S5 1", "rollback_start", "rollback_cmd 1 ok", "rollback_cmd 2 ok", "recovery_check 1 ok", "recovery verified"];

  it("takes statuses from the event log and output from the markers", () => {
    const r = parseRun(sslRenewPlan, events, output);
    expect(r.steps.map((s) => [s.id, s.status, s.exitCode])).toEqual([
      ["S1", "ok", 0], ["S2", "not_run", null], ["S3", "not_run", null], ["S4", "not_run", null], ["S5", "failed", 1], ["S6", "not_run", null],
    ]);
    expect(r.steps[4].output).toContain("nginx: configuration file /etc/nginx/nginx.conf test failed");
    expect(r.steps[4].command).toBe("sudo nginx -t");
    expect(r.rollback).toMatchObject({ ran: true, commands: [{ index: 1, ok: true }, { index: 2, ok: true }] });
    expect(r.rollback.output[1]).toBe("  $ sayops_restore /etc/letsencrypt");
    expect(r.recovery).toBe("verified");
    expect(r.finished).toBe(false);
  });

  it("never reports recovery that the script did not report", () => {
    const r = parseRun(sslRenewPlan, events.filter((e) => !e.startsWith("recovery")), output);
    expect(r.recovery).toBeNull();
    expect(parseRun(sslRenewPlan, [...events.slice(0, -1), "recovery unverified"], output).recovery).toBe("unverified");
  });

  it("marks every step skipped when the condition skips the task", () => {
    const r = parseRun(sslRenewPlan, ["skip all S1"], "sayops: S1 · Check\nsayops: nothing to do");
    expect(r.skippedAll).toBe("S1");
    expect(r.steps.every((s) => s.status === "skipped")).toBe(true);
  });
});

describe("missing backup: detected, never claimed as done", () => {
  const session = align(redactEvents(sslRenewEvents).events);

  it("flags the backup that was said but never run", () => {
    const gaps = findGaps(session);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].narration.text).toContain("I always back up");
    // no observed command does a backup
    expect(session.steps.some((s) => /\bcp\b|backup|\.bak/.test(s.command.cmd))).toBe(false);
  });

  it("the added step is marked as added and cites only what was said, not a command", () => {
    const s3 = sslRenewPlan.steps.find((s) => s.id === "S3")!;
    expect(s3.added).toBe(true);
    expect(s3.sources.every((id) => id.startsWith("N"))).toBe(true);
  });

  it("is never 'ready' until a person accepts the added step", () => {
    expect(assessReadiness({ plan: sslRenewPlan, session, sessionId: "x", version: 1 }).status).toBe("needs_review");
  });

  it("does not report a gap when the backup was observed", () => {
    const withBackup: SessionEvent[] = [...sslRenewEvents, { kind: "command", seq: 40, t: "2026-10-24T10:03:05.000Z", cmd: "ssh web-1 'sudo cp -a /etc/letsencrypt /etc/letsencrypt.bak'", exit: 0, ms: 90, cwd: "/home/ops" }];
    expect(findGaps(align(redactEvents(withBackup).events))).toEqual([]);
  });

  it("reports the gap itself, unresolved, if the model never adds the step", async () => {
    const lazy: Plan = { ...structuredClone(sslRenewPlan), findings: [], steps: sslRenewPlan.steps.filter((s) => s.id !== "S3"), rollback: [{ run: "sudo systemctl start nginx", remote: true, why: "N6" }] };
    const llm: JsonLlm = async () => ({ content: JSON.stringify(lazy), model: "fake" });
    const r = await compile(llm, { title: "t", session });
    const gap = r.plan.findings.find((f) => f.type === "said_not_done");
    expect(gap?.fix_step).toBeNull();
    const readiness = assessReadiness({ plan: r.plan, session, sessionId: "x", version: 1 });
    expect(readiness.status).toBe("blocked");
    expect(readiness.blockers[0]).toContain("Unresolved said not done");
  });
});

describe("recorded sandbox proof", () => {
  it.skipIf(!sslRenewProof)("is internally consistent: passed only when exit code and every check match", () => {
    for (const s of sslRenewProof!.scenarios) {
      expect(s.passed).toBe(s.exitCode === s.expectedExit && s.checks.every((c) => c.ok));
      if (s.recovery === "verified") expect(s.log.join("\n")).toContain("recovery verified");
    }
  });
});
