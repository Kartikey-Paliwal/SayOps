import type { Plan, PlanCheck, PlanStep } from "./schemas";

/**
 * Step-level difference between two plan versions. Steps are matched by what they run, not by
 * id (ids shift when a step is inserted). Every change carries the correction ids (X<n>) that
 * the new version cites for it, so the UI can say which correction caused it.
 */

export interface StepChange {
  id: string;
  /** id of the matching step in the previous version, when it existed */
  previousId?: string;
  intent: string;
  run: string;
  /** X ids cited by the step in the version where it appears */
  causes: string[];
  /** for changed steps: what differs */
  fields?: string[];
}

export interface CheckChange {
  run: string;
  why: string;
  causes: string[];
}

export interface PlanDiff {
  steps: { added: StepChange[]; removed: StepChange[]; changed: StepChange[] };
  params: { added: string[]; removed: string[] };
  rollback: { added: CheckChange[]; removed: CheckChange[] };
  verify: { added: CheckChange[]; removed: CheckChange[] };
  schedule: { from: string | null; to: string | null; causes: string[] } | null;
  findings: { added: string[]; removed: string[] };
  /** true when nothing at all changed */
  empty: boolean;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const causes = (ids: string[]) => [...new Set(ids.filter((id) => id.startsWith("X")))];

function stepFields(a: PlanStep, b: PlanStep): string[] {
  const out: string[] = [];
  if (norm(a.intent) !== norm(b.intent)) out.push("intent");
  if (a.remote !== b.remote) out.push("where it runs");
  if (a.on_fail !== b.on_fail) out.push(`on failure: ${a.on_fail} → ${b.on_fail}`);
  if (a.risk !== b.risk) out.push(`risk: ${a.risk} → ${b.risk}`);
  if (JSON.stringify(a.condition) !== JSON.stringify(b.condition)) out.push(b.condition ? (a.condition ? "condition changed" : "condition added") : "condition removed");
  if (a.added !== b.added) out.push(b.added ? "now marked as added" : "no longer marked as added");
  return out;
}

function checks(prev: PlanCheck[], next: PlanCheck[]) {
  const key = (c: PlanCheck) => `${c.remote}|${norm(c.run)}`;
  const before = new Set(prev.map(key));
  const after = new Set(next.map(key));
  return {
    added: next.filter((c) => !before.has(key(c))).map((c) => ({ run: c.run, why: c.why, causes: causes([c.why]) })),
    removed: prev.filter((c) => !after.has(key(c))).map((c) => ({ run: c.run, why: c.why, causes: [] })),
  };
}

export function diffPlans(prev: Plan, next: Plan): PlanDiff {
  const key = (s: PlanStep) => `${s.remote}|${norm(s.run)}`;
  const unmatchedPrev = new Map<string, PlanStep[]>();
  for (const s of prev.steps) unmatchedPrev.set(key(s), [...(unmatchedPrev.get(key(s)) ?? []), s]);

  const added: StepChange[] = [];
  const changed: StepChange[] = [];
  for (const s of next.steps) {
    const match = unmatchedPrev.get(key(s))?.shift();
    if (!match) {
      added.push({ id: s.id, intent: s.intent, run: s.run, causes: causes(s.sources) });
      continue;
    }
    const fields = stepFields(match, s);
    if (fields.length) {
      changed.push({ id: s.id, previousId: match.id, intent: s.intent, run: s.run, causes: causes([...s.sources, s.condition?.why ?? ""]), fields });
    }
  }
  const removed = [...unmatchedPrev.values()].flat().map((s) => ({ id: s.id, intent: s.intent, run: s.run, causes: [] }));

  const pn = new Set(prev.params.map((p) => p.name));
  const nn = new Set(next.params.map((p) => p.name));
  const from = prev.schedule?.cron ?? null;
  const to = next.schedule?.cron ?? null;
  const fkey = (f: Plan["findings"][number]) => `${f.type}: ${f.detail}`;
  const pf = new Set(prev.findings.map(fkey));
  const nf = new Set(next.findings.map(fkey));

  const diff: PlanDiff = {
    steps: { added, removed, changed },
    params: { added: [...nn].filter((n) => !pn.has(n)), removed: [...pn].filter((n) => !nn.has(n)) },
    rollback: checks(prev.rollback, next.rollback),
    verify: checks(prev.verify, next.verify),
    schedule: from === to ? null : { from, to, causes: causes([next.schedule?.why ?? ""]) },
    findings: { added: [...nf].filter((f) => !pf.has(f)), removed: [...pf].filter((f) => !nf.has(f)) },
    empty: false,
  };
  diff.empty =
    !added.length && !removed.length && !changed.length && !diff.params.added.length && !diff.params.removed.length &&
    !diff.rollback.added.length && !diff.rollback.removed.length && !diff.verify.added.length && !diff.verify.removed.length &&
    !diff.schedule && !diff.findings.added.length && !diff.findings.removed.length;
  return diff;
}

/** Plain-text lines for the CLI. */
export function formatDiff(d: PlanDiff, sources: Record<string, string> = {}): string[] {
  if (d.empty) return ["  No change to the plan."];
  const by = (ids: string[]) => (ids.length ? `  ← ${ids.map((id) => (sources[id] ? `${id} “${sources[id]}”` : id)).join(", ")}` : "");
  const L: string[] = [];
  for (const s of d.steps.added) L.push(`  + ${s.id} ${s.intent}: ${s.run}${by(s.causes)}`);
  for (const s of d.steps.changed) L.push(`  ~ ${s.id} ${s.intent} (${s.fields!.join("; ")})${by(s.causes)}`);
  for (const s of d.steps.removed) L.push(`  - ${s.id} ${s.intent}: ${s.run}`);
  if (d.schedule) L.push(`  ~ schedule: ${d.schedule.from ?? "none"} → ${d.schedule.to ?? "none"} (UTC)${by(d.schedule.causes)}`);
  for (const p of d.params.added) L.push(`  + parameter ${p}`);
  for (const p of d.params.removed) L.push(`  - parameter ${p}`);
  for (const c of d.rollback.added) L.push(`  + rollback: ${c.run}${by(c.causes)}`);
  for (const c of d.rollback.removed) L.push(`  - rollback: ${c.run}`);
  for (const c of d.verify.added) L.push(`  + check: ${c.run}${by(c.causes)}`);
  for (const c of d.verify.removed) L.push(`  - check: ${c.run}`);
  for (const f of d.findings.added) L.push(`  + finding ${f}`);
  for (const f of d.findings.removed) L.push(`  - finding ${f}`);
  return L;
}
