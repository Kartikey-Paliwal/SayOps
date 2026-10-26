import { describe, expect, it } from "vitest";
import {
  CompileError, LlmError, align, findGaps, applyRadar, compile, redactEvents, scan, sslRenewEvents, sslRenewPlan,
  validatePlan, type JsonLlm, type LlmRequest, type Plan,
} from "../src";

const session = align(redactEvents(sslRenewEvents).events);
const clone = (p: Plan): Plan => structuredClone(p);

function fakeLlm(...responses: (Plan | string)[]): JsonLlm & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const fn = async (req: LlmRequest) => {
    calls.push(req);
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { content: typeof r === "string" ? r : JSON.stringify(r), model: "fake" };
  };
  return Object.assign(fn, { calls });
}

describe("validatePlan", () => {
  it("accepts the reference SSL plan", () => {
    const v = validatePlan(sslRenewPlan, session);
    expect(v.ok ? [] : v.errors).toEqual([]);
  });

  it("accepts $-prefixed param references in remote_host", () => {
    const p = clone(sslRenewPlan) as Plan & { remote_host: string };
    p.remote_host = "$HOST";
    const v = validatePlan(p, session);
    expect(v.ok && v.plan.remote_host).toBe("HOST");
  });

  it("normalises near-miss ids and drops non-narrations from narrations", () => {
    const p = clone(sslRenewPlan) as unknown as { steps: { id: string; sources: string[] }[]; narrations: { id: string; kind: string }[]; findings: { fix_step: string | null }[] };
    p.steps.forEach((s, i) => { s.id = `step ${i + 1}`; s.sources = s.sources.map((x) => x.toLowerCase()); });
    p.findings[0].fix_step = "Step-3";
    p.narrations.push({ id: "C1", kind: "context" }, { id: "n1", kind: "context" });
    const v = validatePlan(p, session);
    expect(v.ok ? [] : v.errors).toEqual([]);
    if (v.ok) {
      expect(v.plan.steps.map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
      expect(v.plan.narrations).toHaveLength(7);
    }
  });

  it("rejects citations that do not exist", () => {
    const p = clone(sslRenewPlan);
    p.steps[0].sources.push("C42");
    const v = validatePlan(p, session);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join()).toContain("C42");
  });

  it("requires uncited steps to be marked added", () => {
    const p = clone(sslRenewPlan);
    p.steps[2].added = false;
    const v = validatePlan(p, session);
    expect(!v.ok && v.errors.join()).toContain('S3 cites no command');
  });

  it("rejects hard-coded values that became params", () => {
    const p = clone(sslRenewPlan);
    p.steps[0].run = "sudo certbot certificates -d shop.example.com";
    const v = validatePlan(p, session);
    expect(!v.ok && v.errors.join()).toContain('"shop.example.com" is still hard-coded');
  });

  it("rejects ssh wrappers in run", () => {
    const p = clone(sslRenewPlan);
    p.steps[1].run = "ssh web-1 'sudo systemctl stop nginx'";
    const v = validatePlan(p, session);
    expect(!v.ok && v.errors.join()).toContain("without the ssh wrapper");
  });

  it("classifies a narration the model forgot to list, from the step that uses it", () => {
    const p = clone(sslRenewPlan);
    p.narrations = p.narrations.filter((n) => n.id !== "N5");
    const v = validatePlan(p, session);
    expect(v.ok && v.plan.narrations.some((n) => n.id === "N5")).toBe(true);
  });

  it("requires every narration to be classified or used", () => {
    const p = clone(sslRenewPlan);
    p.narrations = p.narrations.filter((n) => n.id !== "N4");
    p.findings = [];
    p.steps = p.steps.map((s) => ({ ...s, sources: s.sources.filter((x) => x !== "N4") }));
    const v = validatePlan(p, session);
    expect(!v.ok && v.errors.join()).toContain("N4 is missing");
  });
});

describe("compile", () => {
  it("returns the plan, catches the missed backup and keeps the guard", async () => {
    const llm = fakeLlm(sslRenewPlan);
    const r = await compile(llm, { title: "Renew SSL certificate", session });
    expect(r.attempts).toBe(1);
    expect(r.plan.findings.find((f) => f.type === "said_not_done")?.fix_step).toBe("S3");
    expect(r.plan.steps.find((s) => s.run === "sudo nginx -t")?.on_fail).toBe("abort_and_rollback");
    expect(r.plan.steps[0].condition?.scope).toBe("all");
    // the prompt carries labelled data, the typo marker and the redacted token
    expect(llm.calls[0].user).toContain("[failed, retried below]");
    expect(llm.calls[0].user).toContain("<REDACTED:bearer>");
    expect(llm.calls[0].user).not.toContain("9fQ2xLm7");
  });

  it("retries once with the validation errors", async () => {
    const bad = clone(sslRenewPlan);
    bad.steps[0].sources = ["C99"];
    const llm = fakeLlm(bad, sslRenewPlan);
    const r = await compile(llm, { title: "t", session });
    expect(r.attempts).toBe(2);
    expect(llm.calls[1].user).toContain("C99, which does not exist");
  });

  it("spends the retry on truncated output", async () => {
    let n = 0;
    const llm: JsonLlm = async () => {
      if (n++ === 0) throw new LlmError("LLM 400: max completion tokens reached", 400, undefined, "json_validate_failed");
      return { content: JSON.stringify(sslRenewPlan), model: "fake" };
    };
    const r = await compile(llm, { title: "t", session });
    expect(r.attempts).toBe(2);
  });

  it("fails visibly after the retry", async () => {
    const llm = fakeLlm("not json", "still not json");
    await expect(compile(llm, { title: "t", session })).rejects.toBeInstanceOf(CompileError);
  });

  it("includes corrections as X ids the plan may cite", async () => {
    const p = clone(sslRenewPlan);
    p.steps.push({ id: "S7", intent: "Notify Slack", run: 'curl -fsS -X POST "$SLACK_WEBHOOK" -d "{\\"text\\":\\"renewed\\"}"', remote: false, sources: ["X1"], added: true, condition: null, on_fail: "continue", risk: "LOW" });
    const llm = fakeLlm(p);
    const r = await compile(llm, { title: "t", session, corrections: [{ seq: 1, text: "Also post to Slack when it's done" }] });
    expect(r.plan.steps.at(-1)?.sources).toEqual(["X1"]);
    expect(llm.calls[0].user).toContain('X1: "Also post to Slack');
  });
});

describe("danger radar", () => {
  it.each([
    ["rm -rf /var/log/app/*", "HIGH"],
    ["psql -c 'DROP TABLE users'", "HIGH"],
    ["kubectl delete ns staging", "HIGH"],
    ["terraform destroy -auto-approve", "HIGH"],
    ["sudo systemctl restart nginx", "MEDIUM"],
    ["curl -fsSL https://x.sh | sh", "MEDIUM"],
  ])("flags %s as %s", (cmd, risk) => {
    expect(scan(cmd).map((r) => r.risk)).toContain(risk);
  });

  it("leaves safe commands alone", () => {
    for (const cmd of ["sudo nginx -t", "ls -la", "rm file.txt", "sudo systemctl start nginx"]) expect(scan(cmd)).toEqual([]);
  });

  it("raises risk but never lowers it, and flags unexplained HIGH steps", () => {
    const p = clone(sslRenewPlan);
    p.steps[1].risk = "LOW"; // model under-rated `systemctl stop`
    p.steps.push({ id: "S7", intent: "Clean logs", run: "sudo rm -rf /var/log/nginx/old", remote: true, sources: ["C6"], added: false, condition: null, on_fail: "abort", risk: "LOW" });
    const { plan } = applyRadar(p);
    expect(plan.steps[1].risk).toBe("MEDIUM");
    expect(plan.steps.at(-1)?.risk).toBe("HIGH");
    expect(plan.findings.some((f) => f.type === "unexplained_danger" && f.fix_step === "S7")).toBe(true);
    const low = clone(sslRenewPlan);
    low.steps[0].risk = "HIGH";
    expect(applyRadar(low).plan.steps[0].risk).toBe("HIGH");
  });
});

describe("said-vs-did backstop", () => {
  const live = clone(sslRenewPlan);
  // what the live model produced: backup claim read as a reason, no finding, no backup step
  live.narrations = live.narrations.map((n) => (n.id === "N4" ? { ...n, kind: "reason" } : n));
  live.findings = [];
  live.steps = live.steps.filter((s) => s.id !== "S3");
  live.rollback = [{ run: "sudo systemctl start nginx", remote: true, why: "N6" }];

  it("detects the claimed backup that never ran", () => {
    const gaps = findGaps(session);
    expect(gaps.map((g) => [g.narration.seq, g.action.id])).toEqual([[4, "backup"]]);
  });

  it("does not report a gap when the backup ran", () => {
    const events = [...sslRenewEvents, { kind: "command" as const, seq: 50, t: "2026-10-24T10:03:05.000Z", cmd: "ssh web-1 'sudo cp -a /etc/letsencrypt /etc/letsencrypt.bak'", exit: 0, ms: 100, cwd: "/" }];
    expect(findGaps(align(redactEvents(events).events))).toEqual([]);
  });

  it("asks the model to fix a missed gap on the retry", async () => {
    const llm = fakeLlm(live, sslRenewPlan);
    const r = await compile(llm, { title: "t", session });
    expect(r.attempts).toBe(2);
    expect(llm.calls[1].user).toContain('classify N4 as "claim"');
    expect(r.plan.findings.filter((f) => f.type === "said_not_done")).toHaveLength(1);
  });

  it("reports the gap itself when the model misses it twice", async () => {
    const r = await compile(fakeLlm(live, live), { title: "t", session });
    const f = r.plan.findings.find((x) => x.type === "said_not_done");
    expect(f?.sources).toEqual(["N4"]);
    expect(f?.fix_step).toBeNull();
  });

  it("rejects a spoken condition that gates nothing", () => {
    const p = clone(sslRenewPlan);
    p.steps[0].condition = null;
    const v = validatePlan(p, session);
    expect(!v.ok && v.errors.join()).toContain("N2 is a condition but no step");
  });

  it("makes guarded steps abort and roll back", async () => {
    const p = clone(sslRenewPlan);
    p.steps[4].on_fail = "continue"; // nginx -t, cites guard N5
    const r = await compile(fakeLlm(p), { title: "t", session });
    expect(r.plan.steps[4].on_fail).toBe("abort_and_rollback");
  });

  it("rejects leftover redaction markers and orphan backup restores", () => {
    const p = clone(sslRenewPlan);
    p.verify[0].run = "curl -H 'Authorization: Bearer <REDACTED:bearer>' https://$DOMAIN";
    p.steps = p.steps.filter((s) => s.id !== "S3");
    p.findings = [];
    const v = validatePlan(p, session);
    const errs = !v.ok ? v.errors.join("\n") : "";
    expect(errs).toContain("<REDACTED:bearer> is left in a command");
    expect(errs).toContain(`rollback restores /etc/letsencrypt but no step runs "sayops_backup /etc/letsencrypt"`);
  });
});
