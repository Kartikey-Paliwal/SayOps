import { sayopsHome, StoreError } from "@sayops/core/store";
import { readFileSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CliError, compileSession, discard, fixSession, formatDiff, list, recordCommand, show, start, stop, why, type Ctx,
} from "./commands";
import { hookScript, unhookScript } from "./hooks";

export const VERSION = "0.1.0";
const WEB = "http://localhost:3100";

const HELP = `sayops ${VERSION} — record an ops chore once, with the reasons, and turn it into safe automation

Recording (zsh):
  sayops start "<title>"        start a session (--force marks a stuck one as interrupted)
  eval "$(sayops hook zsh)"     turn on command capture in THIS shell only (nothing is written to ~/.zshrc)
  <run your commands>           each command, its exit code, duration and folder are recorded, secrets redacted
  why                           then hold your Wispr Flow key and say why you ran the last command
  why --for C2 "<reason>"       explain a specific earlier command (--context: about the whole session)
  sayops stop                   finish and save the session
  eval "$(sayops unhook zsh)"   turn capture off in this shell (or just close the terminal)

Other commands:
  sayops status                 what is recording right now
  sayops show [id]              commands and explanations, as stored (already redacted)
  sayops list                   all sessions
  sayops compile [id] [--env-file path]   build the plan with the AI compiler (needs GROQ_API_KEY)
  sayops fix [id] ["<correction>"] [--env-file path]
                                talk-to-fix: no text → dictate the correction at the fix> prompt;
                                saves a NEW plan version and shows exactly what changed
  sayops discard --yes          delete the session that is recording

Start a command with a space to keep it out of the recording.
Data lives in $SAYOPS_HOME (default ~/.sayops). Exit codes: 0 ok · 1 error · 2 bad usage.`;

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

function parse(args: string[], valueFlags: string[]): Parsed {
  const out: Parsed = { positional: [], flags: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { out.positional.push(...args.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (valueFlags.includes(k)) {
        const v = inline ?? args[++i];
        if (v === undefined) throw new CliError(`--${k} needs a value`, 2);
        out.flags[k] = v;
      } else out.flags[k] = true;
    } else out.positional.push(a);
  }
  return out;
}

const num = (v: string | true | undefined, name: string) => {
  const n = Number(v);
  if (v === undefined || v === true || !Number.isFinite(n)) throw new CliError(`--${name} must be a number`, 2);
  return n;
};

function invocation(): string[] {
  const script = fileURLToPath(import.meta.url);
  return [process.execPath, ...process.execArgv, script];
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "-h":
      case "--help":
        ctx.out(HELP);
        return 0;
      case "--version":
        ctx.out(VERSION);
        return 0;

      case "start": {
        const p = parse(rest, ["shell"]);
        const s = start(ctx, { title: p.positional.join(" "), shell: p.flags.shell as string | undefined, force: p.flags.force === true });
        ctx.out(`● Recording ${s.id}: ${s.title}`);
        ctx.out(`  1. Turn on capture in this shell (once per terminal):  eval "$(sayops hook zsh)"`);
        ctx.out(`  2. Do the task. After a command, type  why  and hold your Wispr Flow key to say the reason.`);
        ctx.out(`  3. Finish with:  sayops stop`);
        return 0;
      }

      case "hook": {
        const shell = rest[0] ?? "zsh";
        if (shell !== "zsh" && shell !== "bash") throw new CliError(`usage: sayops hook zsh`, 2);
        if (shell === "bash") throw new CliError("bash capture is not supported yet; use zsh (the macOS default shell)");
        ctx.out(hookScript("zsh", invocation(), ctx.home));
        return 0;
      }
      case "unhook":
        ctx.out(unhookScript());
        return 0;

      case "_cmd": {
        // Called by the shell hook in the background. Must never print to the user's terminal or fail loudly.
        try {
          const p = parse(rest, ["session", "seq", "exit", "start", "ms", "cwd"]);
          recordCommand(ctx, {
            session: String(p.flags.session),
            seq: num(p.flags.seq, "seq"),
            exit: num(p.flags.exit, "exit"),
            start: num(p.flags.start, "start"),
            ms: num(p.flags.ms, "ms"),
            cwd: String(p.flags.cwd ?? ""),
            text: ctx.stdin(),
          });
        } catch { /* swallowed on purpose: recording must never disturb the shell */ }
        return 0;
      }

      case "why": {
        const p = parse(rest, ["for", "after", "session"]);
        const text = p.flags.stdin === true ? ctx.stdin() : p.positional.join(" ");
        const r = why(ctx, {
          text,
          after: p.flags.after === undefined ? undefined : num(p.flags.after, "after"),
          forCommand: p.flags.for as string | undefined,
          context: p.flags.context === true,
          session: p.flags.session as string | undefined,
        });
        if (r.attachedTo === null) ctx.out(`  ↳ N${r.narration.seq} saved as context for the whole session`);
        else ctx.out(`  ↳ N${r.narration.seq} explains C${r.attachedTo}${r.command ? `: ${r.command.slice(0, 80)}` : ""}`);
        return 0;
      }

      case "stop": {
        const s = stop(ctx);
        const m = s.summary!;
        ctx.out(`✔ Stopped ${s.id}: ${m.commands} commands (${m.failed} failed), ${m.narrations} explanations, ${m.redactions} secret(s) redacted.`);
        if (m.lost) ctx.err(`sayops: ${m.lost} command(s) were still being recorded when you stopped and were not saved`);
        if (m.malformed) ctx.err(`sayops: ${m.malformed} unreadable line(s) were skipped`);
        ctx.out(`  Review:   sayops show ${s.id}`);
        ctx.out(`  Compile:  sayops compile ${s.id} --env-file ~/Desktop/sayops/.env`);
        ctx.out(`  Open:     ${WEB}/local/${s.id}`);
        ctx.out(`  Capture hooks are now idle. Remove them with: eval "$(sayops unhook zsh)"`);
        return 0;
      }

      case "status": {
        const lines = list(ctx);
        const recording = lines.find((l) => /\srecording\s/.test(l));
        ctx.out(recording ? `● ${recording}` : "No session is recording.");
        return 0;
      }
      case "list":
        for (const l of list(ctx)) ctx.out(l);
        return 0;
      case "show":
        for (const l of show(ctx, rest[0])) ctx.out(l);
        return 0;

      case "discard": {
        const p = parse(rest, []);
        ctx.out(`Discarded ${discard(ctx, { yes: p.flags.yes === true })}.`);
        return 0;
      }

      case "compile": {
        const p = parse(rest, ["env-file"]);
        ctx.err("sayops: compiling with the AI model…");
        const r = await compileSession(ctx, { id: p.positional[0], envFile: p.flags["env-file"] as string | undefined });
        ctx.out(`✔ Compiled ${r.id} → plan v${r.version} with ${r.model} (${r.attempts} attempt${r.attempts > 1 ? "s" : ""}): ${r.plan.steps.length} steps, ${r.plan.rollback.length} rollback, ${r.plan.verify.length} checks.`);
        for (const f of r.plan.findings) ctx.out(`  ⚠ ${f.type.replace(/_/g, " ")}: ${f.detail}`);
        ctx.out(`  Status: ${r.readiness.status.replace("_", " ")}`);
        for (const b of r.readiness.blockers) ctx.out(`  ✖ ${b}`);
        for (const v of r.readiness.reviews) ctx.out(`  • ${v.text}`);
        ctx.out(`  Open: ${WEB}/local/${r.id}`);
        return 0;
      }

      case "fix": {
        const p = parse(rest, ["env-file"]);
        const id = p.positional[0]?.startsWith("so_") ? p.positional.shift() : undefined;
        let text = p.flags.stdin === true ? ctx.stdin() : p.positional.join(" ");
        if (!text.trim() && p.flags.stdin !== true && ctx.readLine) {
          ctx.out("Say what should change (hold your Wispr Flow key), then press Enter:");
          text = ctx.readLine("fix> ") ?? "";
          if (!text.trim()) throw new CliError("cancelled, nothing changed", 130);
        }
        ctx.err("sayops: recompiling with your correction…");
        const r = await fixSession(ctx, { id, text, envFile: p.flags["env-file"] as string | undefined });
        ctx.out(`✔ X${r.correction.seq} “${r.correction.text}” → plan v${r.next.version} (was v${r.previous.version}). What changed:`);
        for (const l of formatDiff(r.diff, r.sources)) ctx.out(l);
        if (r.redactions) ctx.out(`  (${r.redactions} secret(s) in the correction were redacted before saving)`);
        ctx.out(`  Status: ${r.readiness.status.replace("_", " ")}`);
        for (const b of r.readiness.blockers) ctx.out(`  ✖ ${b}`);
        for (const v of r.readiness.reviews) ctx.out(`  • ${v.text}`);
        ctx.out(`  Open: ${WEB}/local/${r.id}`);
        return 0;
      }

      default:
        throw new CliError(`unknown command "${cmd}". Run: sayops help`, 2);
    }
  } catch (e) {
    if (e instanceof CliError) {
      ctx.err(`sayops: ${e.message}`);
      return e.exitCode;
    }
    if (e instanceof StoreError) {
      ctx.err(`sayops: ${e.message}`);
      return 1;
    }
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "EACCES" || err?.code === "EROFS" || err?.code === "ENOSPC") {
      ctx.err(`sayops: cannot write to ${ctx.home} (${err.code}). Set SAYOPS_HOME to a writable folder.`);
      return 1;
    }
    ctx.err(`sayops: unexpected error: ${err?.message ?? String(e)}`);
    return 1;
  }
}

export function realCtx(): Ctx {
  return {
    home: sayopsHome(),
    env: process.env,
    now: () => new Date(),
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    stdin: () => {
      try {
        return readFileSync(0, "utf8");
      } catch {
        return "";
      }
    },
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    readLine: (prompt) => {
      if (!process.stdin.isTTY) return null;
      process.stdout.write(prompt);
      const buf = Buffer.alloc(1);
      let line = "";
      for (;;) {
        let n = 0;
        try {
          n = readSync(0, buf, 0, 1, null);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue;
          return null;
        }
        if (n === 0) return line || null;
        const ch = buf.toString("utf8");
        if (ch === "\n") return line;
        line += ch;
      }
    },
  };
}

const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === (await import("node:fs")).realpathSync(process.argv[1]);
if (isEntry) {
  process.exitCode = await run(process.argv.slice(2), realCtx());
}
