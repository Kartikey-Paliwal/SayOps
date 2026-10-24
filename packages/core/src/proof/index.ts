import type { Plan } from "../schemas";

/**
 * Results of running a generated script inside a disposable sandbox. Everything here is
 * recorded from a real run (see scripts/proof-ssl.ts); nothing is synthesised.
 * Browser-safe: the Docker runner lives in ./runner.ts and is not exported from the package.
 */

export type StepStatus = "ok" | "failed" | "skipped" | "not_run";

export interface ProofStep {
  id: string;
  intent: string;
  /** the exact command the script sent to the sandbox */
  command: string;
  status: StepStatus;
  exitCode: number | null;
  /** everything the step printed (stdout and stderr, in order) */
  output: string[];
}

export interface ProofCheck {
  label: string;
  expected: string;
  actual: string;
  ok: boolean;
}

export interface ProofScenario {
  id: string;
  title: string;
  setup: string;
  expectation: string;
  expectedExit: number;
  exitCode: number;
  durationMs: number;
  /** id of the step whose condition skipped the whole task, if any */
  skippedAll: string | null;
  steps: ProofStep[];
  rollback: { ran: boolean; commands: { index: number; command: string; ok: boolean }[]; output: string[] };
  recovery: "verified" | "unverified" | null;
  verify: { index: number; command: string; ok: boolean }[];
  /** independent checks made by the runner inside the sandbox after the script exited */
  checks: ProofCheck[];
  passed: boolean;
  log: string[];
}

export interface ProofRun {
  generatedAt: string;
  sessionId: string;
  planTitle: string;
  scriptSha256: string;
  environment: { docker: string; image: string; imageId: string; isolation: string[] };
  /** parameters passed to the script (secrets masked) */
  params: Record<string, string>;
  scenarios: ProofScenario[];
}

export interface ParsedRun {
  steps: ProofStep[];
  skippedAll: string | null;
  rollback: ProofScenario["rollback"];
  recovery: ProofScenario["recovery"];
  verify: ProofScenario["verify"];
  finished: boolean;
}

const STEP_MARK = /^sayops: (S\d+) · /;
const ROLLBACK_MARK = /^sayops: rolling back$/;
const VERIFY_MARK = /^sayops: verify (\d+): /;

/**
 * Turns the script's event log (SAYOPS_EVENTS) and its merged stdout/stderr into per-step
 * results. Statuses come only from the event log; output is attributed by the log markers.
 */
export function parseRun(plan: Plan, events: string[], output: string): ParsedRun {
  const status = new Map<string, { status: StepStatus; exitCode: number | null }>();
  let skippedAll: string | null = null;
  let rollbackRan = false;
  const rollbackOk = new Map<number, boolean>();
  let recovery: ParsedRun["recovery"] = null;
  const verifyOk = new Map<number, boolean>();
  let finished = false;

  for (const line of events) {
    const [kind, a, b] = line.trim().split(/\s+/);
    if (kind === "step_start") status.set(a, { status: "not_run", exitCode: null });
    else if (kind === "step_ok") status.set(a, { status: "ok", exitCode: 0 });
    else if (kind === "step_fail") status.set(a, { status: "failed", exitCode: Number(b) });
    else if (kind === "skip" && a === "all") skippedAll = b;
    else if (kind === "skip" && a === "step") status.set(b, { status: "skipped", exitCode: null });
    else if (kind === "rollback_start") rollbackRan = true;
    else if (kind === "rollback_cmd") rollbackOk.set(Number(a), b === "ok");
    else if (kind === "recovery" && (a === "verified" || a === "unverified")) recovery = a;
    else if (kind === "verify") verifyOk.set(Number(a), b === "ok");
    else if (kind === "finished") finished = true;
  }

  // Attribute output lines to the section they were printed in.
  const sections = new Map<string, string[]>();
  let current = "preamble";
  for (const line of output.split("\n")) {
    const step = line.match(STEP_MARK);
    if (step) current = step[1];
    else if (ROLLBACK_MARK.test(line)) current = "rollback";
    else if (VERIFY_MARK.test(line)) current = `verify${line.match(VERIFY_MARK)![1]}`;
    if (!sections.has(current)) sections.set(current, []);
    sections.get(current)!.push(line);
  }

  return {
    steps: plan.steps.map((s) => ({
      id: s.id,
      intent: s.intent,
      command: s.run,
      ...(status.get(s.id) ?? { status: skippedAll ? "skipped" : "not_run", exitCode: null }),
      output: sections.get(s.id) ?? [],
    })),
    skippedAll,
    rollback: {
      ran: rollbackRan,
      commands: plan.rollback
        .map((r, i) => ({ index: i + 1, command: r.run, ok: rollbackOk.get(i + 1) }))
        .filter((c): c is { index: number; command: string; ok: boolean } => c.ok !== undefined),
      output: sections.get("rollback") ?? [],
    },
    recovery,
    verify: plan.verify
      .map((v, i) => ({ index: i + 1, command: v.run, ok: verifyOk.get(i + 1) }))
      .filter((v): v is { index: number; command: string; ok: boolean } => v.ok !== undefined),
    finished,
  };
}
