import type { AlignedSession } from "../align";
import type { Correction } from "../validate";

export interface RenderContext {
  sessionId: string;
  version: number;
  /** "C3" → command text, "N2" → narration text, "X1" → correction text */
  sources: Record<string, string>;
}

export function sourceTexts(session: AlignedSession, corrections: Correction[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of session.context) out[`N${n.seq}`] = n.text;
  for (const s of session.steps) {
    out[`C${s.command.seq}`] = s.command.cmd;
    for (const n of s.narrations) out[`N${n.seq}`] = n.text;
  }
  for (const c of corrections) out[`X${c.seq}`] = c.text;
  return out;
}
