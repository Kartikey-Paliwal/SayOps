import { describe, expect, it } from "vitest";
import {
  align, assessReadiness, diffPlans, ExplainError, explainStep, keepUnrelated, LruCache, sslRenewEvents, sslRenewPlan, Throttle, validatePlan,
  withSpokenReason, type JsonLlm, type LlmRequest, type Plan,
} from "../src";
import { sslRenewReasons } from "../src/seeds/ssl-renew.reasons";

const clone = (p: Plan): Plan => structuredClone(p);

/** What a good compile of "never stop nginx if the disk is over 90% full" (N8 on C3) returns. */
function withDiskGuard(base: Plan): Plan {
  const p = clone(base);
  p.narrations.push({ id: "N8", kind: "guard" });
  p.steps.splice(1, 0, { id: "S2", intent: "Check disk usage", run: "df / | awk 'NR==2 {if ($5+0 > 90) exit 1}'", remote: true, sources: ["N8"], added: true, condition: null, on_fail: "abort", risk: "LOW" });
  p.steps = p.steps.map((s, i) => ({ ...s, id: `S${i + 1}` }));
  p.findings = p.findings.map((f) => ({ ...f, fix_step: "S4" })); // the backup step moved from S3 to S4
  return p;
}
function fake(...plans: Plan[]): JsonLlm & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return Object.assign(async (req: LlmRequest) => {
    calls.push(req);
    return { content: JSON.stringify(plans[Math.min(calls.length - 1, plans.length - 1)]), model: "fake" };
  }, { calls });
}

describe("withSpokenReason", () => {
  it("adds the reason as the next narration, pinned to the chosen command, redacted", () => {
    const token = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789AB"].join("_");
    const r = withSpokenReason(sslRenewEvents, 3, `never stop nginx if the disk is full, token ${token}`);
    expect(r.narration.seq).toBe(8);
    expect(r.overrides[8]).toBe(3);
    expect(r.narration.text).toContain("<REDACTED:github_token>");
    expect(r.redactions).toBe(1);
    expect(JSON.stringify(r.events)).not.toContain(token);
    expect(JSON.stringify(r.events)).not.toContain("9fQ2xLm7"); // the seed's own secret stays redacted too
  });

  it("keeps the original narrations where they were", () => {
    const r = withSpokenReason(sslRenewEvents, 7, "check within 10 seconds");
    expect(r.overrides).toMatchObject({ 1: 1, 2: 1, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 7 });
  });

  it("rejects unknown commands, the dropped typo, and empty or too-long reasons", () => {
    expect(() => withSpokenReason(sslRenewEvents, 99, "x")).toThrow(ExplainError);
    expect(() => withSpokenReason(sslRenewEvents, 2, "x")).toThrow("typo");
    expect(() => withSpokenReason(sslRenewEvents, 3, "   ")).toThrow(ExplainError);
    expect(() => withSpokenReason(sslRenewEvents, 3, "x".repeat(241))).toThrow("240");
  });
});

describe("explainStep", () => {
  it("returns the new plan, the diff caused by N8, and how N8 was classified", async () => {
    const llm = fake(withDiskGuard(sslRenewPlan));
    const r = await explainStep({ llm, title: "t", events: sslRenewEvents, plan: sslRenewPlan, commandSeq: 3, text: "never stop nginx if the disk is over 90% full" });
    expect(r.kind).toBe("guard");
    expect(r.diff.steps.added.map((s) => [s.intent, s.causes])).toEqual([["Check disk usage", ["N8"]]]);
    expect(r.diff.steps.changed).toEqual([]);
    expect(r.session.steps.find((s) => s.command.seq === 3)?.narrations.map((n) => n.seq)).toEqual([3, 8]);
    // the model saw the reason as data on C3, with the previous plan as baseline
    expect(llm.calls[0].user).toContain('N8: "never stop nginx if the disk is over 90% full"');
    expect(llm.calls[0].user).toContain("<previous_plan>");
  });

  it("restores anything the model changed that the new reason did not cause", async () => {
    const drift = withDiskGuard(sslRenewPlan);
    drift.steps[0].condition = { ...drift.steps[0].condition!, skip_if: "true" }; // unasked change to S1
    drift.steps[5].on_fail = "continue"; // unasked change to nginx -t
    drift.narrations = drift.narrations.map((n) => (n.id === "N6" ? { ...n, kind: "claim" } : n));
    const r = await explainStep({ llm: fake(drift), title: "t", events: sslRenewEvents, plan: sslRenewPlan, commandSeq: 3, text: "never stop nginx if the disk is over 90% full" });
    expect(r.diff.steps.changed).toEqual([]);
    expect(r.plan.steps[0].condition).toEqual(sslRenewPlan.steps[0].condition);
    expect(r.plan.steps.find((s) => s.run === "sudo nginx -t")?.on_fail).toBe("abort_and_rollback");
    expect(r.plan.narrations.find((n) => n.id === "N6")?.kind).toBe("rollback");
    expect(r.plan.findings[0].fix_step).toBe(r.plan.steps.find((s) => s.run.startsWith("sayops_backup"))?.id);
  });

  it("the new step needs a person's review before the plan is ready", async () => {
    const r = await explainStep({ llm: fake(withDiskGuard(sslRenewPlan)), title: "t", events: sslRenewEvents, plan: sslRenewPlan, commandSeq: 3, text: "never stop nginx if the disk is over 90% full" });
    const ready = assessReadiness({ plan: r.plan, session: r.session, sessionId: "x", version: 2, decisions: { "said_not_done:S4": "accepted" } });
    expect(ready.status).toBe("needs_review");
    expect(ready.reviews.map((x) => x.text)).toEqual(["Confirm step S2 added from what you said (N8): Check disk usage"]);
  });

  it("a guard reason that nothing cites is rejected (and retried)", () => {
    const p = withDiskGuard(sslRenewPlan);
    p.steps = p.steps.filter((s) => !s.sources.includes("N8"));
    const r = withSpokenReason(sslRenewEvents, 3, "never stop nginx if the disk is over 90% full");
    const v = validatePlan({ ...p, findings: [] }, align(r.events, { overrides: r.overrides }));
    expect(!v.ok && v.errors.join()).toContain("N8 is a guard but no step cites it");
  });

  it("keepUnrelated drops unrelated new steps and brings back unrelated removed ones", () => {
    const next = clone(sslRenewPlan);
    next.steps = next.steps.filter((s) => s.id !== "S6");
    next.steps.push({ ...next.steps[0], id: "S9", run: "echo unrelated", sources: ["C1"], added: true, condition: null });
    const kept = keepUnrelated(sslRenewPlan, next, ["N8"]);
    expect(kept.steps.map((s) => s.run)).toEqual(sslRenewPlan.steps.map((s) => s.run));
  });
});

describe("recorded examples", () => {
  it("are valid plans whose only changes come from the spoken reason (N8)", () => {
    expect(sslRenewReasons.length).toBe(3);
    for (const ex of sslRenewReasons) {
      const r = withSpokenReason(sslRenewEvents, ex.commandSeq, ex.text);
      const v = validatePlan(ex.plan, align(r.events, { overrides: r.overrides }));
      expect(v.ok ? [] : v.errors).toEqual([]);
      const d = diffPlans(sslRenewPlan, ex.plan, { causeIds: ["N8"] });
      expect(d.empty).toBe(false);
      expect(d.steps.removed).toEqual([]);
      expect(d.steps.changed).toEqual([]);
      for (const s of [...d.steps.added, ...d.verify.added]) expect(s.causes).toEqual(["N8"]);
    }
  });
});

describe("Throttle / LruCache", () => {
  it("limits per minute and per day per visitor", () => {
    let t = 0;
    const th = new Throttle({ perMinute: 2, perDay: 3, now: () => t });
    expect(th.take("a").ok).toBe(true);
    expect(th.take("a").ok).toBe(true);
    expect(th.take("a")).toEqual({ ok: false, retryAfterS: 60, reason: "minute" });
    expect(th.take("b").ok).toBe(true); // other visitors unaffected
    t = 61_000;
    expect(th.take("a").ok).toBe(true);
    t = 130_000;
    expect(th.take("a")).toMatchObject({ ok: false, reason: "day" });
  });

  it("after the provider says busy, everyone waits until it's free", () => {
    let t = 0;
    const th = new Throttle({ perMinute: 9, perDay: 99, now: () => t });
    th.markBusy(20);
    expect(th.take("x")).toEqual({ ok: false, retryAfterS: 20, reason: "busy" });
    t = 20_001;
    expect(th.take("x").ok).toBe(true);
  });

  it("cache keeps the newest entries", () => {
    const c = new LruCache<number>(2);
    c.set("a", 1); c.set("b", 2); c.get("a"); c.set("c", 3);
    expect([c.get("a"), c.get("b"), c.get("c")]).toEqual([1, undefined, 3]);
  });
});
