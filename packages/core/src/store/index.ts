/**
 * File-based session store shared by the CLI (writes) and the local web app (reads).
 * Node-only: import from "@sayops/core/store", never from the browser bundle.
 *
 *   $SAYOPS_HOME (default ~/.sayops, mode 0700)
 *     current                      id of the session being recorded (absent when idle)
 *     sessions/<id>/session.json   metadata (no command text)
 *     sessions/<id>/events.jsonl   SessionEvent lines, already redacted — raw text is never written
 *     sessions/<id>/redactions.log one line per redacted item (type only)
 *     sessions/<id>/pending.<seq>  marker while a command is being recorded in the background
 *     sessions/<id>/upload.json    SessionUpload, written by `sayops stop`
 *     sessions/<id>/plan.json      latest Plan (kept for older readers)
 *     sessions/<id>/plans/v<N>.json every plan version: { version, meta, plan } — never overwritten
 *     sessions/<id>/corrections.json corrections (redacted) and what became of each
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { align } from "../align";
import { compile, CompileError } from "../compile";
import { diffPlans, type PlanDiff } from "../diff";
import type { JsonLlm } from "../llm";
import { redactText } from "../redact";
import { Plan, SessionEvent, SessionUpload } from "../schemas";
import type { Correction } from "../validate";

export const SESSION_ID = /^so_[a-z0-9]{6,24}$/;

export const SessionStatus = z.enum(["recording", "stopped", "interrupted"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const StoredSession = z.object({
  id: z.string().regex(SESSION_ID),
  title: z.string().min(1).max(200),
  shell: z.enum(["zsh", "bash"]),
  os: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: SessionStatus,
  /** narration seq → command seq (null = session context); set by `why` */
  overrides: z.record(z.string().regex(/^\d+$/), z.number().int().positive().nullable()),
  /** filled in by stop */
  summary: z
    .object({ commands: z.number(), failed: z.number(), narrations: z.number(), redactions: z.number(), malformed: z.number(), lost: z.number() })
    .nullable(),
});
export type StoredSession = z.infer<typeof StoredSession>;

export class StoreError extends Error {
  constructor(message: string, readonly code: "not_found" | "invalid" | "state" | "io" = "invalid") {
    super(message);
  }
}

export function sayopsHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SAYOPS_HOME || join(homedir(), ".sayops");
}

export function sessionDir(home: string, id: string): string {
  if (!SESSION_ID.test(id)) throw new StoreError(`not a session id: ${JSON.stringify(id)}`);
  return join(home, "sessions", id);
}

export function newSessionId(now = Date.now()): string {
  const rand = Array.from({ length: 4 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
  return `so_${now.toString(36)}${rand}`;
}

export function ensureHome(home: string): void {
  mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
}

/** Write via a temp file + rename so a crash never leaves half a file. */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function currentId(home: string): string | null {
  try {
    const id = readFileSync(join(home, "current"), "utf8").trim();
    return SESSION_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function setCurrent(home: string, id: string | null): void {
  const path = join(home, "current");
  if (id) writeFileAtomic(path, id);
  else rmSync(path, { force: true });
}

export function readSession(home: string, id: string): StoredSession {
  const path = join(sessionDir(home, id), "session.json");
  if (!existsSync(path)) throw new StoreError(`no session ${id}`, "not_found");
  const parsed = StoredSession.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new StoreError(`session ${id} has invalid metadata: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export function writeSession(home: string, s: StoredSession): void {
  const dir = sessionDir(home, s.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dir, "session.json"), `${JSON.stringify(StoredSession.parse(s), null, 2)}\n`);
}

/** Appends one already-redacted event. Small appends are atomic, so background writers can't interleave lines. */
export function appendEvent(home: string, id: string, event: SessionEvent): void {
  const path = join(sessionDir(home, id), "events.jsonl");
  // If an earlier write was cut short (crash, kill), start a fresh line so this event isn't glued onto it.
  const lead = endsMidLine(path) ? "\n" : "";
  appendFileSync(path, `${lead}${JSON.stringify(SessionEvent.parse(event))}\n`, { mode: 0o600 });
}

function endsMidLine(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (!size) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function appendRedactions(home: string, id: string, types: string[]): void {
  if (types.length) appendFileSync(join(sessionDir(home, id), "redactions.log"), types.map((t) => `${t}\n`).join(""), { mode: 0o600 });
}

/** Reads events, skipping (and counting) lines that are not valid events — e.g. a write cut short by a crash. */
export function readEvents(home: string, id: string): { events: SessionEvent[]; malformed: number } {
  const path = join(sessionDir(home, id), "events.jsonl");
  if (!existsSync(path)) return { events: [], malformed: 0 };
  const events: SessionEvent[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = SessionEvent.safeParse(JSON.parse(line));
      if (r.success) events.push(r.data);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

export function countRedactions(home: string, id: string): number {
  const path = join(sessionDir(home, id), "redactions.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
}

export function pendingMarkers(home: string, id: string): string[] {
  try {
    return readdirSync(sessionDir(home, id)).filter((f) => f.startsWith("pending."));
  } catch {
    return [];
  }
}

export function listSessions(home: string): StoredSession[] {
  let ids: string[] = [];
  try {
    ids = readdirSync(join(home, "sessions")).filter((d) => SESSION_ID.test(d));
  } catch {
    return [];
  }
  const out: StoredSession[] = [];
  for (const id of ids) {
    try {
      out.push(readSession(home, id));
    } catch { /* skip unreadable sessions */ }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function readUpload(home: string, id: string): SessionUpload | null {
  const path = join(sessionDir(home, id), "upload.json");
  if (!existsSync(path)) return null;
  return SessionUpload.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function readPlan(home: string, id: string): Plan | null {
  const path = join(sessionDir(home, id), "plan.json");
  if (!existsSync(path)) return null;
  return Plan.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Overrides in the shape `align()` takes. */
export function alignOverrides(s: StoredSession): Record<number, number | null> {
  return Object.fromEntries(Object.entries(s.overrides).map(([k, v]) => [Number(k), v]));
}

// ---- plan versions -------------------------------------------------------------------------

export const PlanVersionMeta = z.object({
  source: z.enum(["compile", "correction"]),
  /** correction seq that produced this version */
  correction: z.number().int().positive().nullable(),
  model: z.string(),
  attempts: z.number().int().nonnegative(),
  at: z.string(),
});
export type PlanVersionMeta = z.infer<typeof PlanVersionMeta>;

export const PlanVersion = z.object({ version: z.number().int().positive(), meta: PlanVersionMeta, plan: Plan });
export type PlanVersion = z.infer<typeof PlanVersion>;

function plansDir(home: string, id: string) {
  return join(sessionDir(home, id), "plans");
}

/** All versions, oldest first. A session compiled before versioning existed reads as v1. */
export function listPlanVersions(home: string, id: string): PlanVersion[] {
  const dir = plansDir(home, id);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^v\d+\.json$/.test(f));
  } catch { /* none yet */ }
  if (!files.length) {
    const legacy = readPlan(home, id);
    return legacy ? [{ version: 1, meta: { source: "compile", correction: null, model: "unknown", attempts: 0, at: "" }, plan: legacy }] : [];
  }
  return files
    .map((f) => PlanVersion.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))))
    .sort((a, b) => a.version - b.version);
}

/** Saves the next version (never overwrites one) and points plan.json at it. */
export function savePlanVersion(home: string, id: string, plan: Plan, meta: PlanVersionMeta): PlanVersion {
  const existing = listPlanVersions(home, id);
  mkdirSync(plansDir(home, id), { recursive: true, mode: 0o700 });
  // A plan compiled before versioning existed is kept as v1 before v2 is written.
  if (existing.length === 1 && !existsSync(join(plansDir(home, id), "v1.json"))) {
    writeFileAtomic(join(plansDir(home, id), "v1.json"), `${JSON.stringify(existing[0], null, 2)}\n`);
  }
  const version = (existing.at(-1)?.version ?? 0) + 1;
  const entry = PlanVersion.parse({ version, meta, plan });
  writeFileAtomic(join(plansDir(home, id), `v${version}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  writeFileAtomic(join(sessionDir(home, id), "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  return entry;
}

// ---- corrections ---------------------------------------------------------------------------

export const StoredCorrection = z.object({
  seq: z.number().int().positive(),
  /** already redacted */
  text: z.string().min(1),
  at: z.string(),
  status: z.enum(["applied", "failed"]),
  /** plan version this correction produced */
  version: z.number().int().positive().nullable(),
  error: z.string().nullable(),
});
export type StoredCorrection = z.infer<typeof StoredCorrection>;

export function readCorrections(home: string, id: string): StoredCorrection[] {
  const path = join(sessionDir(home, id), "corrections.json");
  if (!existsSync(path)) return [];
  return z.array(StoredCorrection).parse(JSON.parse(readFileSync(path, "utf8")));
}

function writeCorrections(home: string, id: string, list: StoredCorrection[]) {
  writeFileAtomic(join(sessionDir(home, id), "corrections.json"), `${JSON.stringify(list, null, 2)}\n`);
}

/** Corrections that made it into a plan, in the shape the compiler and renderers take. */
export function appliedCorrections(home: string, id: string): Correction[] {
  return readCorrections(home, id).filter((c) => c.status === "applied").map((c) => ({ seq: c.seq, text: c.text }));
}

export class CorrectionFailed extends Error {
  constructor(message: string, readonly correction: StoredCorrection, readonly errors: string[] = []) {
    super(message);
  }
}

export interface CorrectionResult {
  correction: StoredCorrection;
  previous: PlanVersion;
  next: PlanVersion;
  diff: PlanDiff;
  redactions: number;
}

/**
 * Talk-to-fix: redact the correction, recompile with every applied correction plus the previous
 * plan as the baseline, validate, and save a NEW version. If anything fails, the correction is
 * recorded as failed with the reason and the previous version stays the latest.
 */
export async function applyCorrection(input: {
  home: string;
  id: string;
  text: string;
  llm: JsonLlm;
  now?: () => Date;
}): Promise<CorrectionResult> {
  const now = input.now ?? (() => new Date());
  const s = readSession(input.home, input.id);
  if (s.status === "recording") throw new StoreError(`session ${s.id} is still recording; stop it first`, "state");
  const previous = listPlanVersions(input.home, input.id).at(-1);
  if (!previous) throw new StoreError(`session ${s.id} has not been compiled yet; compile it before correcting it`, "state");
  const upload = readUpload(input.home, input.id);
  if (!upload) throw new StoreError(`session ${s.id} has no upload.json; it was not stopped cleanly`, "state");

  const raw = input.text.replace(/\s+/g, " ").trim();
  if (!raw) throw new StoreError("the correction is empty; say what should change", "invalid");
  if (raw.length > 1000) throw new StoreError("the correction is longer than 1000 characters; split it up", "invalid");
  const red = redactText(raw);

  const all = readCorrections(input.home, input.id);
  const record: StoredCorrection = {
    seq: all.reduce((m, c) => Math.max(m, c.seq), 0) + 1,
    text: red.text,
    at: now().toISOString(),
    status: "failed",
    version: null,
    error: null,
  };
  appendRedactions(input.home, input.id, red.found);
  const corrections = [...appliedCorrections(input.home, input.id), { seq: record.seq, text: record.text }];
  const session = align(upload.events, { overrides: alignOverrides(s) });

  try {
    const r = await compile(input.llm, { title: s.title, session, corrections, previous: previous.plan });
    const next = savePlanVersion(input.home, input.id, r.plan, { source: "correction", correction: record.seq, model: r.model, attempts: r.attempts, at: now().toISOString() });
    Object.assign(record, { status: "applied", version: next.version });
    return { correction: record, previous, next, diff: diffPlans(previous.plan, next.plan), redactions: red.found.length };
  } catch (e) {
    const errors = e instanceof CompileError ? e.errors : [];
    record.error = e instanceof Error ? e.message + (errors.length ? `: ${errors.join("; ")}` : "") : String(e);
    throw new CorrectionFailed(record.error, record, errors);
  } finally {
    writeCorrections(input.home, input.id, [...all, record]);
  }
}
