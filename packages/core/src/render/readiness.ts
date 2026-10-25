import type { AlignedSession } from "../align";
import type { Finding, Plan } from "../schemas";
import { validatePlan, type Correction } from "../validate";
import { sourceTexts, type RenderContext } from "./context";
import { renderRunbook } from "./runbook";
import { renderScript } from "./script";
import { isSecretParam } from "./shell";
import { renderWorkflow } from "./workflow";

export interface Artifacts {
  script: string;
  workflow: string;
  runbook: string;
}

export interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export function renderAll(plan: Plan, ctx: RenderContext): Artifacts {
  return { script: renderScript(plan, ctx), workflow: renderWorkflow(plan, ctx), runbook: renderRunbook(plan, ctx) };
}

/**
 * Static checks on the rendered artifacts. Pure string checks, so they run anywhere
 * (browser, serverless). shellcheck/actionlint run in the test suite on top of these.
 */
export function checkArtifacts(plan: Plan, a: Artifacts): Check[] {
  const checks: Check[] = [];
  const add = (id: string, label: string, ok: boolean, detail?: string) => checks.push({ id, label, ok, ...(ok ? {} : { detail }) });

  add("strict", "Script runs in strict mode", a.script.startsWith("#!/usr/bin/env bash\n") && a.script.includes("\nset -euo pipefail\n"), "missing shebang or set -euo pipefail");
  const unsourced = plan.steps.filter((s) => !a.script.includes(`# ── ${s.id} ·`) || (s.sources.length > 0 && !a.script.includes(`#    from ${s.sources[0]}`)));
  add("sources", "Every step keeps its source reference", unsourced.length === 0, `no source comment for ${unsourced.map((s) => s.id).join(", ")}`);
  const leaked = Object.entries(a).filter(([, text]) => /<REDACTED:[a-z_]+>/.test(text.replace(/recorded as <REDACTED:[a-z_]+>|was "<REDACTED:[a-z_]+>"/g, "")));
  add("redaction", "No redaction markers left in commands", leaked.length === 0, `found in ${leaked.map(([k]) => k).join(", ")}`);
  const execLines = a.script.split("\n").filter((l) => /\bsayops_(exec|check) (local|remote) '/.test(l));
  const hardcoded = plan.params.filter((p) => !isSecretParam(p.from) && execLines.some((l) => l.includes(p.from)));
  add("params", "Recorded hosts and values are parameters", hardcoded.length === 0, `hard-coded: ${hardcoded.map((p) => p.from).join(", ")}`);
  const unchecked = plan.params.filter((p) => !a.script.includes(`sayops_require ${p.name} `));
  add("required", "Every parameter is required and validated", unchecked.length === 0, `not checked: ${unchecked.map((p) => p.name).join(", ")}`);
  const secretFlags = plan.params.filter((p) => isSecretParam(p.from) && a.script.includes(`--${p.name.toLowerCase().replace(/_/g, "-")})`));
  add("secrets", "Secrets come from the environment, never flags", secretFlags.length === 0, `flag for ${secretFlags.map((p) => p.name).join(", ")}`);
  const ungated = plan.steps.filter((s) => s.risk === "HIGH" && !a.script.includes(`sayops_confirm ${s.id} `));
  add("gates", "HIGH-risk steps need approval", ungated.length === 0, `no gate on ${ungated.map((s) => s.id).join(", ")}`);
  add("injection", "Workflow passes inputs through env, not run:", !runBlocks(a.workflow).some((l) => l.includes("${{")), "${{ }} used inside run:");
  add("permissions", "Workflow token is read-only", /\npermissions:\n {2}contents: read\n/.test(a.workflow), "permissions block missing");
  return checks;
}

/** Every line of every `run:` value in a workflow (single-line and block scalars). */
export function runBlocks(yaml: string): string[] {
  const out: string[] = [];
  let blockIndent = -1;
  for (const line of yaml.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (!line.trim() || indent > blockIndent) { out.push(line); continue; }
      blockIndent = -1;
    }
    const m = line.match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (m) {
      if (/^[|>][-+]?$/.test(m[2])) blockIndent = m[1].length;
      else out.push(m[2]);
    }
  }
  return out;
}

// ---- human review of what SayOps added ---------------------------------------

export type Decision = "accepted" | "dismissed";

export function findingKey(f: Finding): string {
  return `${f.type}:${f.fix_step ?? f.sources.join("+")}`;
}

/** Review key for something a correction added: a step ("correction:S7") or the schedule. */
export function correctionKey(target: string): string {
  return `correction:${target}`;
}

/** Steps added because of a correction (cite an X id) that no finding already asks about. */
export function correctionAdditions(plan: Plan): { key: string; stepId: string | null; text: string }[] {
  const viaFinding = new Set(plan.findings.map((f) => f.fix_step).filter(Boolean));
  const out = plan.steps
    .filter((s) => s.added && !viaFinding.has(s.id) && s.sources.some((id) => id.startsWith("X")))
    .map((s) => ({ key: correctionKey(s.id), stepId: s.id as string | null, text: `Confirm step ${s.id} added from your correction: ${s.intent}` }));
  if (plan.schedule?.why.startsWith("X")) {
    out.push({ key: correctionKey("schedule"), stepId: null, text: `Confirm the schedule added from your correction: cron "${plan.schedule.cron}" (UTC)` });
  }
  return out;
}

/** Dismissing a finding or a correction's addition removes what SayOps added; everything is re-validated after. */
export function applyReview(plan: Plan, decisions: Record<string, Decision>): Plan {
  const dismissed = plan.findings.filter((f) => decisions[findingKey(f)] === "dismissed");
  const dropSteps = new Set(dismissed.map((f) => f.fix_step).filter((id): id is string => Boolean(id)));
  for (const a of correctionAdditions(plan)) {
    if (decisions[a.key] === "dismissed" && a.stepId) dropSteps.add(a.stepId);
  }
  return {
    ...plan,
    steps: plan.steps.filter((s) => !(dropSteps.has(s.id) && s.added)),
    findings: plan.findings.filter((f) => !dismissed.includes(f)),
    schedule: decisions[correctionKey("schedule")] === "dismissed" ? null : plan.schedule,
  };
}

export type ReadinessStatus = "ready" | "needs_review" | "blocked";

export interface Readiness {
  status: ReadinessStatus;
  /** must be fixed: the artifacts are not safe to use */
  blockers: string[];
  /** a human must confirm something SayOps decided */
  reviews: { key: string; text: string }[];
  plan: Plan;
  artifacts: Artifacts | null;
  checks: Check[];
}

/**
 * Applies the reviewer's decisions, re-validates, renders and checks. "ready" only when the
 * plan is valid, every static check passes, nothing is unresolved and every SayOps-added
 * step has been accepted by a human.
 */
export function assessReadiness(input: {
  plan: Plan;
  session: AlignedSession;
  corrections?: Correction[];
  decisions?: Record<string, Decision>;
  sessionId: string;
  version: number;
}): Readiness {
  const decisions = input.decisions ?? {};
  const reviewed = applyReview(input.plan, decisions);
  const blockers: string[] = [];
  const reviews: Readiness["reviews"] = [];

  const v = validatePlan(reviewed, input.session, input.corrections);
  if (!v.ok) {
    blockers.push(...v.errors);
    return { status: "blocked", blockers, reviews, plan: reviewed, artifacts: null, checks: [] };
  }
  const plan = v.plan;
  for (const f of plan.findings) {
    const key = findingKey(f);
    if (!f.fix_step && f.type !== "param_suggest") {
      blockers.push(`Unresolved ${f.type.replace(/_/g, " ")}: ${f.detail}`);
    } else if (f.type === "unguarded_warning") {
      blockers.push(`Unguarded warning: ${f.detail}`);
    } else if (f.fix_step && decisions[key] !== "accepted") {
      reviews.push({ key, text: `Confirm step ${f.fix_step} that SayOps added: ${f.detail}` });
    }
  }
  for (const a of correctionAdditions(plan)) {
    if (decisions[a.key] !== "accepted") reviews.push({ key: a.key, text: a.text });
  }
  const ctx: RenderContext = { sessionId: input.sessionId, version: input.version, sources: sourceTexts(input.session, input.corrections) };
  const artifacts = renderAll(plan, ctx);
  const checks = checkArtifacts(plan, artifacts);
  for (const c of checks) if (!c.ok) blockers.push(`${c.label}: ${c.detail}`);

  const status: ReadinessStatus = blockers.length ? "blocked" : reviews.length ? "needs_review" : "ready";
  return { status, blockers, reviews, plan, artifacts, checks };
}
