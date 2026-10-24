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
 *     sessions/<id>/plan.json      Plan, written by `sayops compile`
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Plan, SessionEvent, SessionUpload } from "../schemas";

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
