import type { AlignedSession } from "./align";
import { Plan } from "./schemas";

export interface Correction {
  seq: number;
  text: string;
}

/** Every C/N/X id the compiler is allowed to cite for this session. */
export function knownSources(session: AlignedSession, corrections: Correction[] = []): Set<string> {
  const ids = new Set<string>();
  for (const n of session.context) ids.add(`N${n.seq}`);
  for (const s of session.steps) {
    ids.add(`C${s.command.seq}`);
    for (const n of s.narrations) ids.add(`N${n.seq}`);
  }
  for (const c of corrections) ids.add(`X${c.seq}`);
  return ids;
}

export type ValidateResult = { ok: true; plan: Plan } | { ok: false; errors: string[] };

/**
 * Deterministic checks on the compiler's output. Errors are written so they can be
 * sent straight back to the model for one retry.
 */
export function validatePlan(raw: unknown, session: AlignedSession, corrections: Correction[] = []): ValidateResult {
  const parsed = Plan.safeParse(normalize(raw));
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "plan"}: ${i.message}`) };
  }
  const plan = parsed.data;
  const errors: string[] = [];
  const known = knownSources(session, corrections);
  const cite = (where: string, id: string) => {
    if (!known.has(id)) errors.push(`${where} cites ${id}, which does not exist in this session`);
  };

  const stepIds = new Set<string>();
  for (const s of plan.steps) {
    if (stepIds.has(s.id)) errors.push(`duplicate step id ${s.id}`);
    stepIds.add(s.id);
    s.sources.forEach((id) => cite(`step ${s.id}`, id));
    if (s.condition) cite(`step ${s.id} condition`, s.condition.why);
    const fromCommand = s.sources.some((id) => id.startsWith("C"));
    if (!fromCommand && !s.added) errors.push(`step ${s.id} cites no command, so it must have "added": true`);
    if (s.remote && !plan.remote_host) errors.push(`step ${s.id} is remote but remote_host is null`);
    if (/^\s*ssh\s/.test(s.run)) errors.push(`step ${s.id}: put the remote command in "run" without the ssh wrapper and set "remote": true`);
  }
  plan.params.forEach((p) => cite(`param ${p.name}`, p.why));
  plan.rollback.forEach((r, i) => cite(`rollback[${i}]`, r.why));
  plan.verify.forEach((v, i) => cite(`verify[${i}]`, v.why));
  plan.narrations.forEach((n) => cite("narrations", n.id));
  for (const f of plan.findings) {
    f.sources.forEach((id) => cite(`finding "${f.type}"`, id));
    if (f.fix_step && !stepIds.has(f.fix_step)) errors.push(`finding "${f.type}" points to missing step ${f.fix_step}`);
  }

  if (plan.remote_host && !plan.params.some((p) => p.name === plan.remote_host)) {
    errors.push(`remote_host ${plan.remote_host} is not one of the params`);
  }
  // A recorded value that became a param must not stay hard-coded anywhere.
  const runs = [
    ...plan.steps.flatMap((s) => [s.run, s.condition?.skip_if ?? ""]),
    ...plan.rollback.map((r) => r.run),
    ...plan.verify.map((v) => v.run),
  ];
  for (const p of plan.params) {
    // "<REQUIRED>" / "<REDACTED:…>" are placeholders for values that were never recorded in clear.
    if (!p.from.startsWith("<") && runs.some((r) => r.includes(p.from))) errors.push(`"${p.from}" is still hard-coded; use $${p.name}`);
  }
  if (plan.schedule) cite("schedule", plan.schedule.why);
  // $PARAM inside single quotes never expands: the command would use the literal text "$PARAM".
  const names = plan.params.map((p) => p.name);
  for (const where of [...plan.steps.map((s) => ({ at: `step ${s.id}`, run: s.run })), ...plan.rollback.map((r, i) => ({ at: `rollback[${i}]`, run: r.run })), ...plan.verify.map((v, i) => ({ at: `verify[${i}]`, run: v.run }))]) {
    for (const name of singleQuotedVars(where.run, names)) {
      errors.push(`${where.at}: $${name} is inside single quotes, so it will not expand; use double quotes (escape inner double quotes) instead`);
    }
  }
  for (const r of runs) {
    const m = r.match(/<REDACTED:[a-z_]+>/);
    if (m) errors.push(`${m[0]} is left in a command; make it a param and use $NAME instead`);
  }
  // A restore needs a backup of the same path; hand-written backup copies are not restores.
  const backedUp = new Set(plan.steps.flatMap((s) => helperPaths(s.run, "sayops_backup")));
  for (const r of plan.rollback) {
    for (const path of helperPaths(r.run, "sayops_restore")) {
      if (!backedUp.has(path)) {
        errors.push(`rollback restores ${path} but no step runs "sayops_backup ${path}" first, so there would be nothing to restore`);
      }
    }
    if (/\.bak|backup/i.test(r.run) && !helperPaths(r.run, "sayops_restore").length) {
      errors.push(`rollback "${r.run}" restores by hand; use sayops_restore <path>`);
    }
  }
  // A condition the engineer spoke must actually gate something.
  for (const n of plan.narrations) {
    if (n.kind === "condition" && !plan.steps.some((s) => s.condition?.why === n.id)) {
      errors.push(`${n.id} is a condition but no step has a "condition" with "why": "${n.id}"; express it as skip_if on the step it gates (scope "all" if it decides whether the job is needed), not as a separate step`);
    }
  }
  // A spoken guard must stop something; a spoken check must be checked.
  for (const n of plan.narrations) {
    // (which step then stops the run is enforced deterministically by enforceGuards)
    if (n.kind === "guard" && !plan.steps.some((s) => s.sources.includes(n.id))) {
      errors.push(`${n.id} is a guard but no step cites it; cite it on the step it protects, or add the check it names as a step before that step`);
    }
    if (n.kind === "verify" && !plan.verify.some((v) => v.why === n.id) && !plan.steps.some((s) => s.sources.includes(n.id))) {
      errors.push(`${n.id} is a verification but nothing checks it; add a "verify" command citing ${n.id}`);
    }
  }
  // Every narration should be classified exactly once.
  const classified = new Set(plan.narrations.map((n) => n.id));
  for (const id of known) {
    if (id.startsWith("N") && !classified.has(id)) errors.push(`narration ${id} is missing from "narrations"`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, plan };
}

/** Names from `names` referenced as $NAME/${NAME} inside a single-quoted part of a shell command. */
export function singleQuotedVars(cmd: string, names: string[]): string[] {
  const found = new Set<string>();
  let quote: "'" | '"' | null = null;
  let segment = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote === "'") {
      if (ch === "'") {
        for (const n of names) if (new RegExp(`\\$(?:\\{${n}\\b|${n}(?![A-Za-z0-9_]))`).test(segment)) found.add(n);
        quote = null;
        segment = "";
      } else segment += ch;
    } else if (ch === "\\") i++;
    else if (quote === '"') { if (ch === '"') quote = null; }
    else if (ch === "'" || ch === '"') quote = ch;
  }
  return [...found];
}

/** Paths passed to sayops_backup / sayops_restore in a command, unquoted and without a trailing slash. */
export function helperPaths(cmd: string, helper: "sayops_backup" | "sayops_restore"): string[] {
  const re = new RegExp(`\\b${helper}\\s+("[^"]+"|'[^']+'|[^\\s;&|]+)`, "g");
  return [...cmd.matchAll(re)].map((m) => m[1].replace(/^["']|["']$/g, "").replace(/\/+$/, ""));
}

/**
 * Rewrites the model's hand-written backup copies into the helpers:
 *   [sudo] cp -a|-r X X.bak<suffix>           → sayops_backup X
 *   [sudo] cp -a|-r X.bak<suffix>[/.] X[/]    → sayops_restore X
 * (cp -r is also rewritten: it drops ownership and permissions, so it is not a faithful backup.)
 * Anything that does not match these exact shapes is left for validation to judge.
 */
export function normalizeBackups(cmd: string): string {
  const P = `("[^"]+"|'[^']+'|[^\\s;&|]+)`;
  const bare = (p: string) => p.replace(/^["']|["']$/g, "").replace(/\/+(\.)?$/, "").replace(/\/+$/, "");
  const arg = (p: string) => (/[\s$]/.test(p) ? `"${p}"` : p);
  return cmd
    .replace(new RegExp(`(?:sudo\\s+)?cp\\s+-(?:a|[rR]p?|p[rR])\\s+${P}\\s+${P}`, "g"), (m, a: string, b: string) => {
      const [src, dst] = [bare(a), bare(b)];
      const BAK = /^(.+?)[._-](?:bak|backup)(?:[._-]|$)/;
      if (BAK.test(dst) && dst.match(BAK)?.[1] === src) return `sayops_backup ${arg(src)}`;
      const base = src.match(BAK)?.[1];
      if (base && base === dst) return `sayops_restore ${arg(dst)}`;
      return m;
    });
}

/** "step 1" → S1, "n-2" → N2, "cmd3" → C3; anything unrecognisable is left for the schema to reject. */
export function normalizeId(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const m = v.trim().toUpperCase().replace(/[\s_\-#:]+/g, "").match(/^(STEP|S|COMMAND|CMD|C|NARRATION|N|CORRECTION|X)(\d+)$/);
  if (!m) return v;
  const prefix = { STEP: "S", S: "S", COMMAND: "C", CMD: "C", C: "C", NARRATION: "N", N: "N", CORRECTION: "X", X: "X" }[m[1]];
  return `${prefix}${Number(m[2])}`;
}

/** Harmless model quirks fixed in place rather than spending the retry on them. */
function normalize(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  type Any = Record<string, unknown>;
  const p = raw as Any;
  const bare = (v: unknown) => (typeof v === "string" ? v.replace(/^\$\{?|\}$/g, "") : v);
  const list = (v: unknown): Any[] => (Array.isArray(v) ? (v as Any[]) : []);
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(normalizeId) : v);
  const withWhy = (x: Any) => ({ ...x, why: normalizeId(x.why) });

  const seen = new Set<unknown>();
  const narrations = list(p.narrations)
    .map((n) => ({ ...n, id: normalizeId(n.id) }))
    .filter((n) => typeof n.id === "string" && /^N\d+$/.test(n.id) && !seen.has(n.id) && seen.add(n.id));

  return {
    ...p,
    remote_host: bare(p.remote_host),
    params: Array.isArray(p.params) ? list(p.params).map((x) => withWhy({ ...x, name: bare(x.name) })) : p.params,
    narrations: Array.isArray(p.narrations) ? narrations : p.narrations,
    steps: Array.isArray(p.steps)
      ? list(p.steps).map((x) => ({
          ...x,
          run: typeof x.run === "string" ? normalizeBackups(x.run) : x.run,
          id: normalizeId(x.id),
          sources: ids(x.sources),
          condition: x.condition && typeof x.condition === "object" ? withWhy(x.condition as Any) : x.condition,
        }))
      : p.steps,
    rollback: Array.isArray(p.rollback)
      ? list(p.rollback).map((r) => withWhy({ ...r, run: typeof r.run === "string" ? normalizeBackups(r.run) : r.run }))
      : p.rollback,
    verify: Array.isArray(p.verify) ? list(p.verify).map(withWhy) : p.verify,
    findings: Array.isArray(p.findings)
      ? list(p.findings).map((f) => ({ ...f, sources: ids(f.sources), fix_step: normalizeId(f.fix_step) }))
      : p.findings,
  };
}
