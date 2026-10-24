import { z } from "zod";

// ---- Recorded session events (one JSONL line each) ----

export const CommandEvent = z.object({
  kind: z.literal("command"),
  seq: z.number().int().positive(),
  t: z.string(), // ISO start time
  cmd: z.string(),
  exit: z.number().int(),
  ms: z.number().int().nonnegative(),
  cwd: z.string(),
});
export type CommandEvent = z.infer<typeof CommandEvent>;

export const NarrationEvent = z.object({
  kind: z.literal("narration"),
  seq: z.number().int().positive(),
  t: z.string(),
  text: z.string(),
});
export type NarrationEvent = z.infer<typeof NarrationEvent>;

export const SessionEvent = z.discriminatedUnion("kind", [CommandEvent, NarrationEvent]);
export type SessionEvent = z.infer<typeof SessionEvent>;

export const SessionMeta = z.object({
  title: z.string().min(1),
  shell: z.enum(["zsh", "bash"]),
  os: z.string(),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

export const SessionUpload = SessionMeta.extend({
  events: z.array(SessionEvent).max(2000),
});
export type SessionUpload = z.infer<typeof SessionUpload>;

// ---- Compiled plan (what the LLM must return) ----
// Every field is required and optional values are `null`: Groq's strict
// structured outputs reject optional properties. `planJsonSchema` mirrors this.

export const NARRATION_KINDS = [
  "reason", "condition", "guard", "verify", "rollback",
  "warning", "param_hint", "claim", "context",
] as const;
export const NarrationKind = z.enum(NARRATION_KINDS);
export type NarrationKind = z.infer<typeof NarrationKind>;

export const RISKS = ["LOW", "MEDIUM", "HIGH"] as const;
export const Risk = z.enum(RISKS);
export type Risk = z.infer<typeof Risk>;

export const ON_FAIL = ["abort", "abort_and_rollback", "continue"] as const;
export const FINDING_TYPES = ["said_not_done", "unguarded_warning", "unexplained_danger", "param_suggest"] as const;

/** Source labels: C<n> = command n, N<n> = narration n, X<n> = correction n. */
export const SourceId = z.string().regex(/^[CNX]\d+$/, "source ids look like C3, N2 or X1");

export const PlanStep = z.object({
  id: z.string().regex(/^S\d+$/, "step ids look like S1"),
  intent: z.string().min(1),
  /** shell command, without any ssh wrapper when remote */
  run: z.string().min(1),
  remote: z.boolean(),
  sources: z.array(SourceId),
  /** true when no recorded command produced this step (said-not-done fix, correction) */
  added: z.boolean(),
  /** shell test that exits 0 when this step (scope "step") or the whole job (scope "all") should be skipped */
  condition: z.object({ skip_if: z.string().min(1), remote: z.boolean(), scope: z.enum(["step", "all"]), why: SourceId }).nullable(),
  on_fail: z.enum(ON_FAIL),
  risk: Risk,
});
export type PlanStep = z.infer<typeof PlanStep>;

export const PlanParam = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "param names are UPPER_SNAKE"),
  /** the recorded value this param replaces, e.g. "web-1" */
  from: z.string().min(1),
  why: SourceId,
  /** regex the value must match, or null */
  validate: z.string().nullable(),
});
export type PlanParam = z.infer<typeof PlanParam>;

export const PlanCheck = z.object({
  /** shell command that must exit 0 */
  run: z.string().min(1),
  remote: z.boolean(),
  why: SourceId,
});
export type PlanCheck = z.infer<typeof PlanCheck>;

export const Finding = z.object({
  type: z.enum(FINDING_TYPES),
  detail: z.string().min(1),
  sources: z.array(SourceId),
  /** id of the step that fixes it (usually an added step), or null */
  fix_step: z.string().nullable(),
});
export type Finding = z.infer<typeof Finding>;

export const Plan = z.object({
  title: z.string().min(1),
  /** name of the param holding the remote host, when any step is remote */
  remote_host: z.string().nullable(),
  params: z.array(PlanParam),
  narrations: z.array(z.object({ id: z.string().regex(/^N\d+$/), kind: NarrationKind })),
  steps: z.array(PlanStep).min(1),
  rollback: z.array(PlanCheck),
  verify: z.array(PlanCheck),
  findings: z.array(Finding),
});
export type Plan = z.infer<typeof Plan>;

// ---- JSON Schema for strict structured output ----

type Json = Record<string, unknown>;
const str: Json = { type: "string" };
const bool: Json = { type: "boolean" };
const nullable = (s: Json): Json => ({ anyOf: [s, { type: "null" }] });
const obj = (properties: Record<string, Json>): Json => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const arr = (items: Json): Json => ({ type: "array", items });
const en = (values: readonly string[]): Json => ({ type: "string", enum: [...values] });

const desc = (description: string): Json => ({ type: "string", description });
const sourceId = desc("source id exactly like C3 (command), N2 (narration) or X1 (correction)");
const stepId = desc("step id exactly like S1, S2, ...");
const narrationId = desc("narration id exactly like N1; only narrations, never commands");

const check = obj({ run: str, remote: bool, why: sourceId });

export const planJsonSchema: Json = obj({
  title: str,
  remote_host: nullable(str),
  params: arr(obj({ name: desc("UPPER_SNAKE name without $"), from: str, why: sourceId, validate: nullable(str) })),
  narrations: arr(obj({ id: narrationId, kind: en(NARRATION_KINDS) })),
  steps: arr(obj({
    id: stepId, intent: str, run: str, remote: bool, sources: arr(sourceId), added: bool,
    condition: nullable(obj({ skip_if: str, remote: bool, scope: en(["step", "all"]), why: sourceId })),
    on_fail: en(ON_FAIL),
    risk: en(RISKS),
  })),
  rollback: arr(check),
  verify: arr(check),
  findings: arr(obj({ type: en(FINDING_TYPES), detail: str, sources: arr(sourceId), fix_step: nullable(stepId) })),
});
