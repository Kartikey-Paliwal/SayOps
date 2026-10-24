import { align, redactEvents } from "@sayops/core";
import { alignOverrides, readEvents, readPlan, readSession, sayopsHome, SESSION_ID } from "@sayops/core/store";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { SessionView } from "../../s/[id]/session-view";

// Sessions recorded with the CLI on this machine ($SAYOPS_HOME, default ~/.sayops).
// Read at request time on the server only; a hosted deployment has no such folder and 404s.

export function generateStaticParams() {
  // Cache Components needs at least one param; real ids are only known at request time.
  return [{ id: "so_placeholder" }];
}

export const metadata: Metadata = { title: "Local session · SayOps" };

export default function LocalSessionPage(props: PageProps<"/local/[id]">) {
  return (
    <Suspense fallback={<p className="mx-auto max-w-6xl px-4 py-10 text-zinc-500 sm:px-6">Loading session…</p>}>
      <LocalSession params={props.params} />
    </Suspense>
  );
}

async function LocalSession({ params }: { params: PageProps<"/local/[id]">["params"] }) {
  await connection();
  const { id } = await params;
  if (!SESSION_ID.test(id)) notFound();
  const home = sayopsHome();
  let stored;
  try {
    stored = readSession(home, id);
  } catch {
    notFound();
  }
  const { events } = readEvents(home, id);
  // Stored events are already redacted by the CLI; redacting again is a cheap second guard.
  const { events: safe } = redactEvents(events);
  const session = align(safe, { overrides: alignOverrides(stored) });
  const plan = readPlan(home, id);
  const narrationCount = safe.filter((e) => e.kind === "narration").length;

  if (!plan) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 pb-24 pt-6 sm:px-6">
        <nav className="text-sm"><Link href="/" className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← SayOps</Link></nav>
        <p className="mt-4 font-mono text-xs uppercase tracking-widest text-zinc-500">Local session · {id} · {stored.status}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{stored.title}</h1>
        <p className="mt-2 text-sm text-zinc-500">
          {session.steps.length} commands · {narrationCount} spoken reasons · recorded {new Date(stored.startedAt).toLocaleString()}
        </p>
        <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          {stored.status === "recording" ? (
            <>Still recording. Finish with <code className="font-mono">sayops stop</code>, then compile.</>
          ) : (
            <>Not compiled yet. Run <code className="font-mono">sayops compile {id} --env-file ~/Desktop/sayops/.env</code> and reload.</>
          )}
        </div>
        <ol className="mt-6 space-y-3">
          {session.context.map((n) => (
            <li key={`N${n.seq}`} className="rounded-lg bg-sky-50 px-3 py-2 text-sm dark:bg-sky-950/50">N{n.seq} · {n.text}</li>
          ))}
          {session.steps.map((s) => (
            <li key={s.command.seq} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex items-start gap-2">
                <span className="font-mono text-xs text-zinc-400">C{s.command.seq}</span>
                <code className="min-w-0 flex-1 break-all font-mono text-sm">$ {s.command.cmd}</code>
                <span className={`rounded px-1.5 font-mono text-xs ${s.command.exit ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"}`}>exit {s.command.exit}</span>
              </div>
              {s.narrations.map((n) => (
                <p key={n.seq} className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-sm dark:bg-sky-950/50">N{n.seq} · {n.text}</p>
              ))}
            </li>
          ))}
        </ol>
      </main>
    );
  }

  return (
    <SessionView
      sessionId={id}
      title={stored.title}
      summary={`Recorded with the SayOps CLI on this machine, ${new Date(stored.startedAt).toLocaleString()}.`}
      shell={stored.shell}
      redacted={stored.summary?.redactions ?? 0}
      narrationCount={narrationCount}
      session={session}
      plan={plan}
      proof={null}
      proofMatchesScript={false}
    />
  );
}
