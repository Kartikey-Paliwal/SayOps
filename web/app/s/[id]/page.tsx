import { align, getSeed, redactEvents, renderScript, SEEDS, sourceTexts } from "@sayops/core";
import { createHash } from "node:crypto";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SessionView } from "./session-view";

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
  // The recorded proof only counts if it was made with exactly the script this page generates.
  const script = renderScript(seed.plan, { sessionId: seed.id, version: 1, sources: sourceTexts(session) });
  const scriptSha256 = createHash("sha256").update(script).digest("hex");

  return (
    <SessionView
      sessionId={seed.id}
      title={seed.meta.title}
      summary={seed.summary}
      shell={seed.meta.shell}
      redacted={count}
      narrationCount={events.filter((e) => e.kind === "narration").length}
      session={session}
      plan={seed.plan}
      proof={seed.proof}
      proofMatchesScript={seed.proof?.scriptSha256 === scriptSha256}
    />
  );
}
