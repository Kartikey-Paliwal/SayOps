import type { CommandEvent, NarrationEvent, SessionEvent } from "./schemas";

export interface AlignedStep {
  command: CommandEvent;
  narrations: NarrationEvent[];
  /** true when a later command with the same base succeeded after this one failed */
  superseded: boolean;
}

export interface AlignedSession {
  context: NarrationEvent[];
  steps: AlignedStep[];
}

/** Commands that are part of the recorder itself and never become steps. */
const SELF_COMMAND = /^\s*(sayops|why)(\s|$)/;

/**
 * Deterministic narration → command alignment.
 *
 * Convention (what `why` prints back to the user): a narration explains the
 * command run just before it. Narrations before the first command explain the
 * first command if it follows within `maxGapMs`, otherwise they are session
 * context. `overrides` (narration seq → command seq, or null for context)
 * come from the user dragging a bubble in the UI and always win.
 */
export function align(
  events: SessionEvent[],
  opts: { maxGapMs?: number; overrides?: Record<number, number | null> } = {},
): AlignedSession {
  const maxGapMs = opts.maxGapMs ?? 90_000;
  const overrides = opts.overrides ?? {};

  const sorted = [...events].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const commands = sorted.filter(
    (e): e is CommandEvent => e.kind === "command" && !SELF_COMMAND.test(e.cmd),
  );
  const steps: AlignedStep[] = commands.map((command) => ({ command, narrations: [], superseded: false }));
  const bySeq = new Map(steps.map((s) => [s.command.seq, s]));
  const context: NarrationEvent[] = [];

  let lastStep: AlignedStep | undefined;
  const pending: NarrationEvent[] = [];

  for (const e of sorted) {
    if (e.kind === "command") {
      const step = bySeq.get(e.seq);
      if (!step) continue;
      if (!lastStep) {
        for (const n of pending) {
          if (Date.parse(e.t) - Date.parse(n.t) <= maxGapMs) step.narrations.push(n);
          else context.push(n);
        }
        pending.length = 0;
      }
      lastStep = step;
      continue;
    }
    if (e.seq in overrides) continue; // placed below
    if (lastStep) lastStep.narrations.push(e);
    else pending.push(e);
  }
  context.push(...pending);

  for (const [nSeq, cSeq] of Object.entries(overrides)) {
    const n = sorted.find((e): e is NarrationEvent => e.kind === "narration" && e.seq === Number(nSeq));
    if (!n) continue;
    const target = cSeq === null ? undefined : bySeq.get(cSeq);
    (target ? target.narrations : context).push(n);
  }
  for (const s of steps) s.narrations.sort((a, b) => a.seq - b.seq);

  markRetries(steps);
  return { context, steps };
}

/** A failed command followed by a successful one with the same first word is a typo/retry. */
function markRetries(steps: AlignedStep[]) {
  for (let i = 0; i < steps.length - 1; i++) {
    const a = steps[i], b = steps[i + 1];
    if (a.command.exit !== 0 && b.command.exit === 0 && sameIntent(a.command.cmd, b.command.cmd)) {
      a.superseded = true;
      b.narrations.unshift(...a.narrations);
      a.narrations = [];
    }
  }
}

function sameIntent(a: string, b: string): boolean {
  const words = (s: string) => s.trim().replace(/^sudo\s+/, "").split(/\s+/);
  const [wa, wb] = [words(a), words(b)];
  if (wa[0] === wb[0]) return true;
  // typo in the first word, e.g. `sytemctl` → `systemctl`
  return wa.slice(1).join(" ") === wb.slice(1).join(" ") && editDistance(wa[0], wb[0]) <= 2;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Compact labelled form fed to the compiler: C<seq> / N<seq>. */
export function toPromptLines(session: AlignedSession): string {
  const out: string[] = [];
  for (const n of session.context) out.push(`N${n.seq} (context): ${JSON.stringify(n.text)}`);
  for (const s of session.steps) {
    const c = s.command;
    const tag = s.superseded ? " [failed, retried below]" : "";
    out.push(`C${c.seq} exit=${c.exit} cwd=${c.cwd}${tag}: ${c.cmd}`);
    for (const n of s.narrations) out.push(`  N${n.seq}: ${JSON.stringify(n.text)}`);
  }
  return out.join("\n");
}
