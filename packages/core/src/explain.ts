import { align, type AlignedSession } from "./align";
import { compile } from "./compile";
import { diffPlans, type PlanDiff } from "./diff";
import { validatePlan } from "./validate";
import type { JsonLlm } from "./llm";
import { redactEvents, redactText } from "./redact";
import type { NarrationEvent, NarrationKind, Plan, SessionEvent } from "./schemas";

/**
 * "Say it yourself": add one spoken reason to a recorded command and see what it changes.
 * Pure (no I/O) apart from the model call, so the browser can rebuild the same session for display.
 */

export const MAX_REASON_CHARS = 240;

export class ExplainError extends Error {}

export interface SpokenReason {
  /** events with the new narration appended (input events redacted first) */
  events: SessionEvent[];
  /** narration seq → command seq, so the reason attaches to the chosen command */
  overrides: Record<number, number>;
  narration: NarrationEvent;
  /** secrets found in the reason and redacted */
  redactions: number;
}

/** Appends a (redacted) reason for command `commandSeq`. Deterministic: same input, same output. */
export function withSpokenReason(events: SessionEvent[], commandSeq: number, text: string): SpokenReason {
  const safe = redactEvents(events).events;
  const aligned = align(safe);
  const step = aligned.steps.find((s) => s.command.seq === commandSeq);
  if (!step) throw new ExplainError(`there is no command C${commandSeq} in this session`);
  if (step.superseded) {
    throw new ExplainError(`C${commandSeq} was a typo that was retried; explain the command that ran instead`);
  }
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw) throw new ExplainError("say why this command matters");
  if (raw.length > MAX_REASON_CHARS) throw new ExplainError(`keep it under ${MAX_REASON_CHARS} characters`);
  const red = redactText(raw);
  const seq = safe.filter((e) => e.kind === "narration").reduce((m, e) => Math.max(m, e.seq), 0) + 1;
  const after = Date.parse(step.command.t) + step.command.ms + 1;
  const narration: NarrationEvent = { kind: "narration", seq, t: new Date(after).toISOString(), text: red.text };
  // Keep the original narrations where align put them, and pin the new one to the chosen command.
  const overrides: Record<number, number> = {};
  for (const s of aligned.steps) for (const n of s.narrations) overrides[n.seq] = s.command.seq;
  overrides[seq] = commandSeq;
  return { events: [...safe, narration], overrides, narration, redactions: red.found.length };
}

export interface ExplainResult {
  plan: Plan;
  narration: NarrationEvent;
  session: AlignedSession;
  diff: PlanDiff;
  /** how the compiler classified the new reason, e.g. "guard" */
  kind: NarrationKind | null;
  model: string;
  redactions: number;
}

/** Recompiles with the new reason, using the current plan as the baseline, and diffs the result. */
export async function explainStep(input: {
  llm: JsonLlm;
  title: string;
  events: SessionEvent[];
  plan: Plan;
  commandSeq: number;
  text: string;
  /** 0 = return immediately on a rate limit (public site on a free tier) */
  rateLimitWaitS?: number;
}): Promise<ExplainResult> {
  const r = withSpokenReason(input.events, input.commandSeq, input.text);
  const session = align(r.events, { overrides: r.overrides });
  const compiled = await compile(input.llm, {
    title: input.title,
    session,
    previous: input.plan,
    rateLimitWaitS: input.rateLimitWaitS,
  });
  const id = `N${r.narration.seq}`;
  // Only what the new sentence caused may change: everything else is restored from the baseline.
  const pinned = keepUnrelated(input.plan, compiled.plan, [id]);
  const v = validatePlan(pinned, session);
  const plan = v.ok ? v.plan : compiled.plan; // pinning never makes a valid plan invalid in practice; fall back if it did
  return {
    plan,
    narration: r.narration,
    session,
    diff: diffPlans(input.plan, plan, { causeIds: [id] }),
    kind: plan.narrations.find((n) => n.id === id)?.kind ?? null,
    model: compiled.model,
    redactions: r.redactions,
  };
}

/**
 * Restores every part of `next` that does not cite one of `newIds` to how it was in `prev`:
 * steps (matched by what they run), narration kinds, params, rollback, verify, schedule and findings.
 * The result differs from `prev` only where the new sentence is cited.
 */
export function keepUnrelated(prev: Plan, next: Plan, newIds: string[]): Plan {
  const isNew = (ids: (string | undefined | null)[]) => ids.some((id) => !!id && newIds.includes(id));
  const key = (s: { remote: boolean; run: string }) => `${s.remote}|${s.run.replace(/\s+/g, " ").trim()}`;
  const before = new Map(prev.steps.map((s) => [key(s), s]));

  const steps = next.steps
    .filter((s) => before.has(key(s)) || isNew([...s.sources, s.condition?.why])) // drop unrelated new steps
    .map((s) => {
      const old = before.get(key(s));
      if (!old || isNew([...s.sources, s.condition?.why])) return s;
      return { ...old, id: s.id };
    });
  // Unrelated steps the model dropped come back, in their original position.
  for (const [i, old] of prev.steps.entries()) {
    if (!steps.some((s) => key(s) === key(old))) steps.splice(Math.min(i, steps.length), 0, old);
  }
  const numbered = steps.map((s, i) => ({ ...s, id: `S${i + 1}` }));
  /** id a step of `plan` now has in `numbered` (matched by what it runs) */
  const nowId = (plan: Plan, stepId: string | null): string | null => {
    const s = stepId ? plan.steps.find((x) => x.id === stepId) : undefined;
    return s ? (numbered.find((x) => key(x) === key(s))?.id ?? null) : null;
  };
  const keepList = <T extends { why: string }>(a: T[], b: T[]) => (b.some((x) => isNew([x.why])) ? b : a);

  return {
    ...prev,
    narrations: [...prev.narrations, ...next.narrations.filter((n) => isNew([n.id]))],
    params: [...prev.params, ...next.params.filter((p) => isNew([p.why]) && !prev.params.some((q) => q.name === p.name))],
    steps: numbered,
    rollback: keepList(prev.rollback, next.rollback),
    verify: keepList(prev.verify, next.verify),
    schedule: next.schedule && isNew([next.schedule.why]) ? next.schedule : prev.schedule,
    findings: [
      ...prev.findings.map((f) => ({ ...f, fix_step: nowId(prev, f.fix_step) })),
      ...next.findings.filter((f) => isNew(f.sources)).map((f) => ({ ...f, fix_step: nowId(next, f.fix_step) })),
    ],
  };
}
