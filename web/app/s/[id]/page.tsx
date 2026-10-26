import { align, getSeed, redactEvents, renderScript, SEEDS, sourceTexts } from "@sayops/core";
import { createHash } from "node:crypto";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { sayItYourselfAction } from "./actions";
import { SessionView, type VersionInfo } from "./session-view";

// A live "say it yourself" compile takes ~5–15 s; give the server action room.
export const maxDuration = 60;

export function generateStaticParams() {
  return SEEDS.map((s) => ({ id: s.id }));
}

export async function generateMetadata(props: PageProps<"/s/[id]">): Promise<Metadata> {
  const seed = getSeed((await props.params).id);
  return { title: seed ? `${seed.meta.title} · SayOps` : "SayOps" };
}

export default function SessionPage(props: PageProps<"/s/[id]">) {
  return (
    <Suspense fallback={<p className="mx-auto max-w-6xl px-4 py-10 text-zinc-500 sm:px-6">Loading session…</p>}>
      <Session params={props.params} />
    </Suspense>
  );
}

async function Session({ params }: { params: PageProps<"/s/[id]">["params"] }) {
  const { id } = await params;
  const seed = getSeed(id);
  if (!seed) notFound();

  // Same path an uploaded session takes: redact first, then align. The plan is the seed's
  // cached compile, so this page needs no LLM key.
  const { events, count } = redactEvents(seed.events);
  const session = align(events);
  const ex = seed.correction;
  const corrections = ex ? [ex.correction] : [];
  // The recorded proof only counts for a version whose script is byte-identical to the one proven.
  const proves = (plan: typeof seed.plan, version: number) =>
    seed.proof?.scriptSha256 ===
    createHash("sha256").update(renderScript(plan, { sessionId: seed.id, version: 1, sources: sourceTexts(session, corrections) })).digest("hex") &&
    version === 1;
  const versions: VersionInfo[] = [
    { version: 1, plan: seed.plan, correction: null, model: "seeded", at: "", proofMatches: proves(seed.plan, 1) },
    ...(ex ? [{ version: 2, plan: ex.plan, correction: ex.correction, model: ex.model, at: ex.recordedAt, proofMatches: proves(ex.plan, 2) }] : []),
  ];

  return (
    <SessionView
      sessionId={seed.id}
      title={seed.meta.title}
      summary={seed.summary}
      shell={seed.meta.shell}
      redacted={count}
      narrationCount={events.filter((e) => e.kind === "narration").length}
      session={session}
      versions={versions}
      corrections={corrections}
      correctionMode={ex ? { kind: "example", text: ex.correction.text, recordedAt: ex.recordedAt, model: ex.model } : { kind: "none" }}
      proof={seed.proof}
      sayIt={{
        seedId: seed.id,
        events,
        commands: session.steps.filter((s) => !s.superseded).map((s) => ({ seq: s.command.seq, cmd: s.command.cmd })),
        examples: seed.reasons,
        live: Boolean(process.env.GROQ_API_KEY),
        run: sayItYourselfAction,
      }}
    />
  );
}
