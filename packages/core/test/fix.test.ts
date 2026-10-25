import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  align, assessReadiness, diffPlans, formatDiff, redactEvents, renderWorkflow, singleQuotedVars, sourceTexts,
  sslRenewEvents, sslRenewMeta, sslRenewPlan, validatePlan, type JsonLlm, type LlmRequest, type Plan,
} from "../src";
import { sslRenewCorrection } from "../src/seeds/ssl-renew.correction";
import {
  applyCorrection, CorrectionFailed, listPlanVersions, readCorrections, readPlan, savePlanVersion, writeFileAtomic, writeSession,
} from "../src/store";

const session = align(redactEvents(sslRenewEvents).events);
const clone = (p: Plan): Plan => structuredClone(p);
const X1 = { seq: 1, text: "Also post to Slack when it's done, and run this every Monday at 9." };

/** What a correct compile of X1 returns (mirrors the recorded live output). */
function withSlack(base: Plan, why = "X1"): Plan {
  const p = clone(base);
  p.params.push({ name: "SLACK_WEBHOOK", from: "<REDACTED:secret>", why, validate: null });
  p.steps.push({ id: "S7", intent: "Notify Slack", run: 'curl -fsS -X POST -d "{\\"text\\":\\"renewed $DOMAIN\\"}" "$SLACK_WEBHOOK"', remote: false, sources: [why], added: true, condition: null, on_fail: "continue", risk: "LOW" });
  p.schedule = { cron: "0 9 * * 1", why };
  return p;
}

function fakeLlm(...responses: (Plan | string | Error)[]): JsonLlm & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const fn = async (req: LlmRequest) => {
    calls.push(req);
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return { content: typeof r === "string" ? r : JSON.stringify(r), model: "fake" };
  };
  return Object.assign(fn, { calls });
}

describe("diffPlans", () => {
  it("reports exactly the step, schedule and parameter a correction added, with its cause", () => {
    const d = diffPlans(sslRenewPlan, withSlack(sslRenewPlan));
    expect(d.steps.added.map((s) => [s.id, s.causes])).toEqual([["S7", ["X1"]]]);
    expect(d.steps.removed).toEqual([]);
    expect(d.steps.changed).toEqual([]);
    expect(d.schedule).toEqual({ from: null, to: "0 9 * * 1", causes: ["X1"] });
    expect(d.params.added).toEqual(["SLACK_WEBHOOK"]);
    expect(d.empty).toBe(false);
    const text = formatDiff(d, sourceTexts(session, [X1])).join("\n");
    expect(text).toContain("+ S7 Notify Slack");
    expect(text).toContain("← X1 “Also post to Slack");
  });

  it("matches steps by what they run, so renumbering is not a change", () => {
    const next = clone(sslRenewPlan);
    next.steps.splice(1, 0, { ...next.steps[1], id: "S2", run: "sudo systemctl status nginx", sources: ["X1"], added: true });
    next.steps = next.steps.map((s, i) => ({ ...s, id: `S${i + 1}` }));
    const d = diffPlans(sslRenewPlan, next);
    expect(d.steps.added.map((s) => s.run)).toEqual(["sudo systemctl status nginx"]);
    expect(d.steps.changed).toEqual([]);
  });

  it("reports removed and changed steps", () => {
    const next = clone(sslRenewPlan);
    next.steps = next.steps.filter((s) => s.id !== "S6");
    next.steps[0] = { ...next.steps[0], on_fail: "abort_and_rollback", sources: [...next.steps[0].sources, "X1"] };
    const d = diffPlans(sslRenewPlan, next);
    expect(d.steps.removed.map((s) => s.id)).toEqual(["S6"]);
    expect(d.steps.changed[0]).toMatchObject({ id: "S1", causes: ["X1"], fields: ["on failure: abort → abort_and_rollback"] });
  });

  it("says when nothing changed", () => {
    expect(diffPlans(sslRenewPlan, clone(sslRenewPlan)).empty).toBe(true);
    expect(formatDiff(diffPlans(sslRenewPlan, sslRenewPlan))).toEqual(["  No change to the plan."]);
  });
});

describe("plan rules for corrections", () => {
  it("rejects a parameter inside single quotes (it would never expand)", () => {
    expect(singleQuotedVars(`curl -d '{"text":"$DOMAIN"}' "$SLACK"`, ["DOMAIN", "SLACK"])).toEqual(["DOMAIN"]);
    expect(singleQuotedVars(`curl -w '%{http_code}' "https://$DOMAIN"`, ["DOMAIN"])).toEqual([]);
    const p = withSlack(sslRenewPlan);
    p.steps[6].run = `curl -d '{"text":"renewed $DOMAIN"}' "$SLACK_WEBHOOK"`;
    const v = validatePlan(p, session, [X1]);
    expect(!v.ok && v.errors.join()).toContain("$DOMAIN is inside single quotes");
  });

  it("requires a correction-added step and schedule to be reviewed before ready", () => {
    const base = { session, corrections: [X1], sessionId: "ssl-renew", version: 2 };
    const accepted = { "said_not_done:S3": "accepted" as const };
    const r = assessReadiness({ ...base, plan: withSlack(sslRenewPlan), decisions: accepted });
    expect(r.status).toBe("needs_review");
    expect(r.reviews.map((x) => x.key)).toEqual(["correction:S7", "correction:schedule"]);
    const all = { ...accepted, "correction:S7": "accepted" as const, "correction:schedule": "accepted" as const };
    expect(assessReadiness({ ...base, plan: withSlack(sslRenewPlan), decisions: all }).status).toBe("ready");
    const dismissed = assessReadiness({ ...base, plan: withSlack(sslRenewPlan), decisions: { ...accepted, "correction:S7": "dismissed", "correction:schedule": "dismissed" } });
    expect(dismissed.plan.steps.some((s) => s.id === "S7")).toBe(false);
    expect(dismissed.plan.schedule).toBeNull();
  });

  it("renders the schedule into the workflow, citing the correction", () => {
    const wf = renderWorkflow(withSlack(sslRenewPlan), { sessionId: "ssl-renew", version: 2, sources: sourceTexts(session, [X1]) });
    expect(wf).toContain('  schedule:\n    - cron: "0 9 * * 1"');
    expect(wf).toContain("# From X1: \"Also post to Slack when it's done, and run this every Monday at 9.\" (GitHub runs cron in UTC)");
    expect(wf).toContain("SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK }}");
  });

  const actionlint = [join(__dirname, "../../../.tools/bin"), ...(process.env.PATH ?? "").split(delimiter)].map((d) => join(d, "actionlint")).find((p) => existsSync(p));
  it.skipIf(!actionlint)("scheduled workflow passes actionlint", () => {
    const dir = mkdtempSync(join(tmpdir(), "sayops-wf-"));
    try {
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(join(dir, ".github", "workflows", "w.yml"), renderWorkflow(withSlack(sslRenewPlan), { sessionId: "x", version: 2, sources: {} }));
      const r = spawnSync(actionlint!, [".github/workflows/w.yml"], { cwd: dir, encoding: "utf8" });
      expect(r.stdout + r.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the recorded SSL example is a valid, reviewable plan that only adds what was asked", () => {
    expect(sslRenewCorrection).not.toBeNull();
    const ex = sslRenewCorrection!;
    const v = validatePlan(ex.plan, session, [ex.correction]);
    expect(v.ok ? [] : v.errors).toEqual([]);
    const d = diffPlans(sslRenewPlan, ex.plan);
    expect(d.steps.removed).toEqual([]);
    expect(d.steps.added.length).toBeGreaterThan(0);
    expect(d.steps.added.every((s) => s.causes.includes("X1"))).toBe(true);
    expect(d.schedule?.to).toBe("0 9 * * 1");
  });
});

describe("applyCorrection (store)", () => {
  let home: string;
  const id = "so_fixtest0001";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sayops-fix-"));
    writeSession(home, { id, title: sslRenewMeta.title, shell: "zsh", os: "darwin", startedAt: "2026-10-24T10:00:00.000Z", endedAt: "2026-10-24T10:10:00.000Z", status: "stopped", overrides: {}, summary: null });
    const events = redactEvents(sslRenewEvents).events;
    writeFileAtomic(join(home, "sessions", id, "upload.json"), JSON.stringify({ ...sslRenewMeta, events }));
    savePlanVersion(home, id, sslRenewPlan, { source: "compile", correction: null, model: "fake", attempts: 1, at: "t" });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("saves a new version without touching the old one, and records the correction", async () => {
    const llm = fakeLlm(withSlack(sslRenewPlan));
    const r = await applyCorrection({ home, id, text: X1.text, llm });
    expect(r.previous.version).toBe(1);
    expect(r.next.version).toBe(2);
    expect(r.diff.steps.added.map((s) => s.id)).toEqual(["S7"]);
    const versions = listPlanVersions(home, id);
    expect(versions.map((v) => [v.version, v.meta.source, v.meta.correction])).toEqual([[1, "compile", null], [2, "correction", 1]]);
    expect(versions[0].plan).toEqual(sslRenewPlan); // v1 untouched
    expect(readPlan(home, id)?.schedule?.cron).toBe("0 9 * * 1"); // plan.json = latest
    expect(readCorrections(home, id)).toMatchObject([{ seq: 1, status: "applied", version: 2, error: null }]);
    // the model saw the previous plan as the baseline and the correction as X1
    expect(llm.calls[0].user).toContain("<previous_plan>");
    expect(llm.calls[0].user).toContain(`X1: ${JSON.stringify(X1.text)}`);
  });

  it("keeps earlier corrections when applying the next one", async () => {
    await applyCorrection({ home, id, text: X1.text, llm: fakeLlm(withSlack(sslRenewPlan)) });
    const llm = fakeLlm(withSlack(sslRenewPlan));
    const r = await applyCorrection({ home, id, text: "make the Slack step optional", llm });
    expect(r.next.version).toBe(3);
    expect(llm.calls[0].user).toContain("X1:");
    expect(llm.calls[0].user).toContain('X2: "make the Slack step optional"');
    expect(r.diff.empty).toBe(true);
  });

  it("redacts secrets in the correction before saving or sending it", async () => {
    const llm = fakeLlm(withSlack(sslRenewPlan));
    // Fake token, assembled at runtime so secret scanners don't mistake the test file for a leak.
    const hook = ["xoxb", "123456789012", "abcdefghijklmnop"].join("-");
    const r = await applyCorrection({ home, id, text: `post to Slack with token ${hook}`, llm });
    expect(r.redactions).toBe(1);
    const stored = readdirSync(join(home, "sessions", id)).map((f) => (f === "plans" ? "" : readFileSync(join(home, "sessions", id, f), "utf8"))).join("\n");
    expect(stored).not.toContain(hook);
    expect(llm.calls[0].user).not.toContain(hook);
    expect(readCorrections(home, id)[0].text).toContain("<REDACTED:slack_token>");
  });

  it("on a failed recompile: records why, keeps the previous version as latest", async () => {
    const broken = withSlack(sslRenewPlan);
    broken.steps[6].sources = ["X9"]; // cites a correction that does not exist, twice
    await expect(applyCorrection({ home, id, text: X1.text, llm: fakeLlm(broken, broken) })).rejects.toBeInstanceOf(CorrectionFailed);
    expect(listPlanVersions(home, id).map((v) => v.version)).toEqual([1]);
    expect(readPlan(home, id)).toEqual(sslRenewPlan);
    const [c] = readCorrections(home, id);
    expect(c).toMatchObject({ seq: 1, status: "failed", version: null });
    expect(c.error).toContain("X9");
    // a failed correction is not fed into later compiles
    const llm = fakeLlm(withSlack(sslRenewPlan, "X2"));
    await applyCorrection({ home, id, text: "try again: post to Slack", llm });
    expect(llm.calls[0].user).not.toContain("X1:");
  });

  it("on a model error: records it and keeps the previous version", async () => {
    await expect(applyCorrection({ home, id, text: X1.text, llm: fakeLlm(new Error("LLM 503: unavailable")) })).rejects.toThrow("503");
    expect(listPlanVersions(home, id)).toHaveLength(1);
    expect(readCorrections(home, id)[0]).toMatchObject({ status: "failed", error: "LLM 503: unavailable" });
  });

  it("refuses empty corrections, uncompiled or still-recording sessions", async () => {
    await expect(applyCorrection({ home, id, text: "   ", llm: fakeLlm(sslRenewPlan) })).rejects.toThrow("empty");
    rmSync(join(home, "sessions", id, "plans"), { recursive: true });
    rmSync(join(home, "sessions", id, "plan.json"));
    await expect(applyCorrection({ home, id, text: "x", llm: fakeLlm(sslRenewPlan) })).rejects.toThrow("not been compiled");
    expect(readCorrections(home, id)).toEqual([]);
  });

  it("migrates a session compiled before versioning (plan.json only) to v1 + v2", async () => {
    rmSync(join(home, "sessions", id, "plans"), { recursive: true });
    expect(listPlanVersions(home, id).map((v) => v.version)).toEqual([1]);
    await applyCorrection({ home, id, text: X1.text, llm: fakeLlm(withSlack(sslRenewPlan)) });
    expect(readdirSync(join(home, "sessions", id, "plans")).sort()).toEqual(["v1.json", "v2.json"]);
  });
});
