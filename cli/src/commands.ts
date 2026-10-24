import {
  align, assessReadiness, CompileError, compile, groq, LlmError, redactText, SessionUpload,
  type AlignedSession, type CommandEvent, type NarrationEvent,
} from "@sayops/core";
import {
  alignOverrides, appendEvent, appendRedactions, countRedactions, currentId, ensureHome, listSessions, newSessionId,
  pendingMarkers, readEvents, readPlan, readSession, readUpload, sessionDir, setCurrent, StoreError, writeFileAtomic,
  writeSession, type StoredSession,
} from "@sayops/core/store";
import { existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Everything a command needs from the outside world — injectable for tests. */
export interface Ctx {
  home: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
  /** whole stdin (only read when a command needs it) */
  stdin: () => string;
  sleep: (ms: number) => void;
}

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

const usage = (msg: string) => new CliError(msg, 2);

function requireActive(ctx: Ctx, explicit?: string): StoredSession {
  const id = explicit ?? currentId(ctx.home);
  if (!id) throw new CliError("no session is recording. Start one with: sayops start \"what you're about to do\"");
  try {
    const s = readSession(ctx.home, id);
    if (s.status !== "recording") throw new CliError(`session ${id} is ${s.status}, not recording`);
    return s;
  } catch (e) {
    if (e instanceof StoreError && e.code === "not_found") {
      setCurrent(ctx.home, null);
      throw new CliError(`the recording session ${id} no longer exists (its files were removed); start a new one`);
    }
    throw e;
  }
}

// ---- start ---------------------------------------------------------------------------------

export function start(ctx: Ctx, opts: { title: string; shell?: string; force?: boolean }): StoredSession {
  const title = opts.title.trim();
  if (!title) throw usage('give the session a title, e.g. sayops start "rotate the dev certificate"');
  if (title.length > 200) throw usage("the title is longer than 200 characters");
  const shell = (opts.shell ?? (ctx.env.SHELL?.endsWith("bash") ? "bash" : "zsh")) as "zsh" | "bash";
  if (shell !== "zsh" && shell !== "bash") throw usage(`unsupported shell: ${shell}`);
  ensureHome(ctx.home);

  const active = currentId(ctx.home);
  if (active) {
    let old: StoredSession | null = null;
    try {
      old = readSession(ctx.home, active);
    } catch { /* dangling pointer: just replace it */ }
    if (old?.status === "recording") {
      if (!opts.force) {
        throw new CliError(`session ${active} ("${old.title}") is still recording. Run "sayops stop" first, or "sayops start --force" to mark it interrupted.`);
      }
      finalize(ctx, old, "interrupted");
      ctx.err(`sayops: marked ${active} as interrupted`);
    }
  }

  const s: StoredSession = {
    id: newSessionId(ctx.now().getTime()),
    title,
    shell,
    os: process.platform,
    startedAt: ctx.now().toISOString(),
    endedAt: null,
    status: "recording",
    overrides: {},
    summary: null,
  };
  writeSession(ctx.home, s);
  writeFileSync(join(sessionDir(ctx.home, s.id), "events.jsonl"), "", { mode: 0o600 });
  setCurrent(ctx.home, s.id);
  return s;
}

// ---- command capture (called by the shell hook, in the background) ----------------------------

export function recordCommand(
  ctx: Ctx,
  opts: { session: string; seq: number; exit: number; start: number; ms: number; cwd: string; text: string },
): CommandEvent | null {
  const s = readSession(ctx.home, opts.session);
  const marker = join(sessionDir(ctx.home, s.id), `pending.${opts.seq}`);
  try {
    if (s.status !== "recording") return null;
    const text = opts.text.replace(/\n+$/, "");
    if (!text.trim()) return null;
    const cmd = redactText(text);
    const cwd = redactText(opts.cwd);
    const event: CommandEvent = {
      kind: "command",
      seq: opts.seq,
      t: new Date(opts.start * 1000).toISOString(),
      cmd: cmd.text.slice(0, 4000),
      exit: opts.exit,
      ms: Math.max(0, Math.round(opts.ms)),
      cwd: cwd.text,
    };
    appendEvent(ctx.home, s.id, event);
    appendRedactions(ctx.home, s.id, [...cmd.found, ...cwd.found]);
    return event;
  } finally {
    rmSync(marker, { force: true });
  }
}

// ---- why ----------------------------------------------------------------------------------------

export function why(
  ctx: Ctx,
  opts: { text: string; after?: number; forCommand?: string; context?: boolean; session?: string },
): { narration: NarrationEvent; attachedTo: number | null; command?: string } {
  const s = requireActive(ctx, opts.session);
  const raw = opts.text.replace(/\s+/g, " ").trim();
  if (!raw) throw usage("the explanation is empty. Say why you ran the last command, e.g.: why the config must be tested before restarting");
  if (raw.length > 2000) throw usage("the explanation is longer than 2000 characters; split it into several `why`s");

  let { events } = readEvents(ctx.home, s.id);
  let target: number | null = null;
  if (opts.context) target = null;
  else if (opts.forCommand !== undefined) {
    const m = opts.forCommand.match(/^C?(\d+)$/i);
    if (!m) throw usage(`--for expects a command like C3, got "${opts.forCommand}"`);
    target = Number(m[1]);
    if (!events.some((e) => e.kind === "command" && e.seq === target)) {
      throw new CliError(`there is no recorded command C${target} in this session. See them with: sayops show`);
    }
  } else if (opts.after !== undefined && opts.after > 0) {
    target = opts.after;
  } else {
    const last = events.filter((e): e is CommandEvent => e.kind === "command").at(-1);
    target = last ? last.seq : null;
  }

  // The hook writes commands in the background; give an in-flight write a moment to land.
  if (target !== null && !events.some((e) => e.kind === "command" && e.seq === target)) {
    for (let i = 0; i < 20 && pendingMarkers(ctx.home, s.id).length; i++) ctx.sleep(50);
    events = readEvents(ctx.home, s.id).events;
  }

  const red = redactText(raw);
  const seq = events.filter((e) => e.kind === "narration").reduce((m, e) => Math.max(m, e.seq), 0) + 1;
  const narration: NarrationEvent = { kind: "narration", seq, t: ctx.now().toISOString(), text: red.text };
  appendEvent(ctx.home, s.id, narration);
  appendRedactions(ctx.home, s.id, red.found);
  // Explicit association: exact even if timestamps or background writes disagree.
  if (opts.context || opts.forCommand !== undefined || (opts.after !== undefined && opts.after > 0)) {
    writeSession(ctx.home, { ...readSession(ctx.home, s.id), overrides: { ...readSession(ctx.home, s.id).overrides, [String(seq)]: target } });
  }
  const command = events.find((e): e is CommandEvent => e.kind === "command" && e.seq === target)?.cmd;
  return { narration, attachedTo: target, command };
}

// ---- stop / discard -------------------------------------------------------------------------

function finalize(ctx: Ctx, s: StoredSession, status: "stopped" | "interrupted"): StoredSession {
  for (let i = 0; i < 60 && pendingMarkers(ctx.home, s.id).length; i++) ctx.sleep(50);
  const lost = pendingMarkers(ctx.home, s.id);
  for (const f of lost) unlinkSync(join(sessionDir(ctx.home, s.id), f));
  const { events, malformed } = readEvents(ctx.home, s.id);
  const commands = events.filter((e) => e.kind === "command");
  const done: StoredSession = {
    ...s,
    status,
    endedAt: ctx.now().toISOString(),
    summary: {
      commands: commands.length,
      failed: commands.filter((c) => c.kind === "command" && c.exit !== 0).length,
      narrations: events.length - commands.length,
      redactions: countRedactions(ctx.home, s.id),
      malformed,
      lost: lost.length,
    },
  };
  const upload = SessionUpload.parse({ title: s.title, shell: s.shell, os: s.os, events: events.slice(0, 2000) });
  writeFileAtomic(join(sessionDir(ctx.home, s.id), "upload.json"), `${JSON.stringify(upload, null, 2)}\n`);
  writeSession(ctx.home, done);
  if (currentId(ctx.home) === s.id) setCurrent(ctx.home, null);
  return done;
}

export function stop(ctx: Ctx): StoredSession {
  return finalize(ctx, requireActive(ctx), "stopped");
}

export function discard(ctx: Ctx, opts: { yes: boolean }): string {
  const s = requireActive(ctx);
  if (!opts.yes) throw usage(`this deletes everything recorded in ${s.id}. Run "sayops discard --yes" to confirm.`);
  setCurrent(ctx.home, null);
  rmSync(sessionDir(ctx.home, s.id), { recursive: true, force: true });
  return s.id;
}

// ---- reading -----------------------------------------------------------------------------------

export function resolveId(ctx: Ctx, id?: string): string {
  if (id) {
    readSession(ctx.home, id); // validates and checks existence
    return id;
  }
  const cur = currentId(ctx.home);
  if (cur) return cur;
  const latest = listSessions(ctx.home)[0];
  if (!latest) throw new CliError("there are no sessions yet. Start one with: sayops start \"title\"");
  return latest.id;
}

export function loadAligned(ctx: Ctx, id: string): { session: StoredSession; aligned: AlignedSession; malformed: number } {
  const session = readSession(ctx.home, id);
  const { events, malformed } = readEvents(ctx.home, id);
  return { session, aligned: align(events, { overrides: alignOverrides(session) }), malformed };
}

export function show(ctx: Ctx, id?: string): string[] {
  const { session, aligned, malformed } = loadAligned(ctx, resolveId(ctx, id));
  const L = [`${session.id} · ${session.title} · ${session.status} · started ${session.startedAt}`];
  for (const n of aligned.context) L.push(`  ↳ N${n.seq} (context) ${n.text}`);
  for (const step of aligned.steps) {
    const c = step.command;
    L.push(`C${c.seq} [exit ${c.exit}${c.exit ? " FAILED" : ""}, ${c.ms} ms] $ ${c.cmd}${step.superseded ? "   (typo, retried next)" : ""}`);
    for (const n of step.narrations) L.push(`  ↳ N${n.seq} ${n.text}`);
  }
  if (!aligned.steps.length && !aligned.context.length) L.push("  (nothing recorded yet)");
  const unexplained = aligned.steps.filter((s) => !s.narrations.length && !s.superseded).map((s) => `C${s.command.seq}`);
  if (unexplained.length) L.push(`Not explained yet: ${unexplained.join(", ")} (add one with: why --for C<n> "reason")`);
  if (malformed) L.push(`Warning: ${malformed} unreadable line(s) were skipped.`);
  return L;
}

export function list(ctx: Ctx): string[] {
  const all = listSessions(ctx.home);
  if (!all.length) return ["no sessions yet"];
  return all.map((s) => {
    const sum = s.summary ? `${s.summary.commands} commands, ${s.summary.narrations} explanations` : "recording";
    return `${s.id}  ${s.status.padEnd(11)} ${s.startedAt.slice(0, 16).replace("T", " ")}  ${s.title}  (${sum})${readPlan(ctx.home, s.id) ? " · compiled" : ""}`;
  });
}

// ---- compile ---------------------------------------------------------------------------------

export async function compileSession(ctx: Ctx, opts: { id?: string; envFile?: string }) {
  const id = resolveId(ctx, opts.id);
  const s = readSession(ctx.home, id);
  if (s.status === "recording") throw new CliError(`session ${id} is still recording. Run "sayops stop" first.`);
  const upload = readUpload(ctx.home, id);
  if (!upload) throw new CliError(`session ${id} has no upload.json; it was not stopped cleanly`);
  if (!upload.events.some((e) => e.kind === "command")) throw new CliError(`session ${id} recorded no commands, so there is nothing to compile`);

  const env = { ...ctx.env };
  if (opts.envFile) {
    if (!existsSync(opts.envFile)) throw usage(`env file not found: ${opts.envFile}`);
    const { parseEnv } = await import("node:util");
    const { readFileSync } = await import("node:fs");
    Object.assign(env, parseEnv(readFileSync(opts.envFile, "utf8")));
  }
  if (!env.GROQ_API_KEY) throw new CliError("GROQ_API_KEY is not set. Pass --env-file ~/Desktop/sayops/.env or export it.");

  const aligned = align(upload.events, { overrides: alignOverrides(s) });
  try {
    const r = await compile(groq({ apiKey: env.GROQ_API_KEY, model: env.LLM_MODEL || undefined }), { title: s.title, session: aligned });
    const dir = sessionDir(ctx.home, id);
    writeFileAtomic(join(dir, "plan.json"), `${JSON.stringify(r.plan, null, 2)}\n`);
    writeFileAtomic(join(dir, "compile.json"), `${JSON.stringify({ model: r.model, attempts: r.attempts, usage: r.usage, radarHits: r.radarHits, at: ctx.now().toISOString() }, null, 2)}\n`);
    const readiness = assessReadiness({ plan: r.plan, session: aligned, sessionId: id, version: 1 });
    return { id, plan: r.plan, model: r.model, attempts: r.attempts, readiness };
  } catch (e) {
    if (e instanceof CompileError) throw new CliError(`the compiler could not produce a valid plan:\n- ${e.errors.join("\n- ")}`);
    if (e instanceof LlmError) throw new CliError(`the model call failed: ${e.message}${e.retryAfterS ? ` (retry in ${e.retryAfterS}s)` : ""}`);
    throw e;
  }
}
