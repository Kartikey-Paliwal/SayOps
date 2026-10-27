import { align, assessReadiness, redactEvents, SEEDS } from "@sayops/core";
import Link from "next/link";
import type { ReactNode } from "react";
import { HeroTerminal } from "@/components/hero-terminal";
import { Reveal } from "@/components/reveal";
import { SiteFooter, SiteHeader } from "@/components/site-header";

const GITHUB = "https://github.com/Kartikey-Paliwal/SayOps";

export default function Home() {
  const demo = SEEDS[0];
  // Real numbers from the demo session, its plan and its recorded sandbox run.
  const { events } = redactEvents(demo.events);
  const session = align(events);
  const reasons = events.filter((e) => e.kind === "narration").length;
  const checks = assessReadiness({ plan: demo.plan, session, sessionId: demo.id, version: 1 }).checks.length;
  const gaps = demo.plan.findings.filter((f) => f.type === "said_not_done").length;
  const proved = demo.proof ? `${demo.proof.scenarios.filter((s) => s.passed).length}/${demo.proof.scenarios.length}` : "—";

  return (
    <>
      <SiteHeader />
      <main>
        {/* ---- hero ---- */}
        <section className="relative overflow-hidden">
          <div aria-hidden className="bg-grid absolute inset-0" />
          <div aria-hidden className="bg-glow absolute inset-0" />
          <div className="relative mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pb-16 pt-16 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pt-24">
            <div className="animate-fade-up">
              <a
                href="https://www.wemakedevs.org/wispr"
                className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted hover:text-foreground"
              >
                <span className="relative flex h-2 w-2">
                  <span className="ping-soft absolute inline-flex h-full w-full rounded-full bg-violet-500" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500" />
                </span>
                Built by voice for the Wispr Flow No Hands challenge
              </a>
              <h1 className="mt-6 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
                Do the chore once.
                <br />
                <span className="text-gradient">Say why.</span> Get safe automation.
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
                SayOps records your terminal and the reasons you speak with Wispr Flow, then turns them into a guarded script, a
                GitHub workflow and a runbook. It even catches the steps you said you&apos;d do but never ran.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link href={`/s/${demo.id}`} className="btn btn-primary">
                  Open the live demo <span aria-hidden>→</span>
                </Link>
                <a href={GITHUB} className="btn btn-ghost">View on GitHub</a>
              </div>
              <p className="mt-5 text-sm text-muted">No sign-in · try it with your own Wispr · every script proven in a sandbox</p>
            </div>
            <div className="animate-fade-up [animation-delay:150ms]">
              <HeroTerminal />
            </div>
          </div>
        </section>

        {/* ---- numbers ---- */}
        <section aria-label="The demo in numbers" className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <Reveal>
            <dl className="card grid grid-cols-2 divide-line overflow-hidden sm:grid-cols-4 sm:divide-x">
              <Stat value={String(reasons)} label="spoken reasons" note="dictated with Wispr Flow" />
              <Stat value={String(demo.plan.steps.length)} label="guarded steps" note="each cites what you ran or said" />
              <Stat value={String(gaps)} label="missed step caught" note="you said it, it never ran" accent />
              <Stat value={proved} label="sandbox scenarios proved" note={`plus ${checks} safety checks`} />
            </dl>
          </Reveal>
        </section>

        {/* ---- how it works ---- */}
        <section id="how" className="mx-auto w-full max-w-6xl px-4 pt-28 sm:px-6">
          <Reveal>
            <p className="eyebrow">How it works</p>
            <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
              Your reasons are the missing piece of every runbook.
            </h2>
            <p className="mt-4 max-w-2xl text-muted">
              Scripts keep the commands and lose the why. SayOps keeps both, and the why is what makes the automation safe.
            </p>
          </Reveal>
          <ol className="mt-12 grid gap-4 md:grid-cols-4">
            {STEPS.map((s, i) => (
              <Reveal key={s.title} delay={i * 90}>
                <li className="card h-full p-5">
                  <span className="font-mono text-xs text-accent">0{i + 1}</span>
                  <h3 className="mt-2 font-semibold">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
                  <code className="mt-4 block truncate rounded-lg bg-surface-2 px-2.5 py-1.5 font-mono text-xs">{s.code}</code>
                </li>
              </Reveal>
            ))}
          </ol>
        </section>

        {/* ---- features ---- */}
        <section id="features" className="mx-auto w-full max-w-6xl px-4 pt-28 sm:px-6">
          <Reveal>
            <p className="eyebrow">What you get</p>
            <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Careful as you are on your best day.</h2>
          </Reveal>
          <div className="mt-12 grid gap-4 md:grid-cols-6">
            <Feature className="md:col-span-4" title="Said vs did" body="You said you always back up first. No backup ran. SayOps flags it, adds the step and waits for your OK before anything is ready.">
              <div className="rounded-xl border border-amber-300/70 bg-amber-50 p-4 dark:border-amber-800/70 dark:bg-amber-950/30">
                <p className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-300">Caught a missing step</p>
                <p className="mt-2 font-medium">You said it. It never ran.</p>
                <p className="mt-1 text-sm italic text-muted">“Before this I always back up the old cert folder.”</p>
                <code className="mt-3 block rounded-md bg-white/70 px-2 py-1 font-mono text-xs dark:bg-black/30">+ S3 sayops_backup /etc/letsencrypt</code>
              </div>
            </Feature>
            <Feature className="md:col-span-2" title="Your words become guards" body="Every check and rollback is annotated with the sentence that produced it.">
              <pre className="overflow-hidden rounded-xl bg-zinc-950 p-3 font-mono text-[11px] leading-5 text-zinc-300">
{`# S5 · Test the nginx config
#  from N5 “Always test the config
#  before starting”
if sayops_exec remote 'sudo nginx -t'
then ok; else rollback; fi`}
              </pre>
            </Feature>
            <Feature className="md:col-span-2" title="Proven in a sandbox" body="The generated script runs in throwaway, network-less containers, including a broken config that must roll back.">
              <ul className="space-y-1.5 text-sm">
                {(demo.proof?.scenarios ?? []).map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] ${s.passed ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-red-500/15 text-red-600"}`}>{s.passed ? "✓" : "✗"}</span>
                    {s.title}
                  </li>
                ))}
              </ul>
            </Feature>
            <Feature className="md:col-span-2" title="Talk to fix it" body="Say “also post to Slack and run it every Monday at 9”. You get a new version and exactly what changed.">
              <div className="space-y-1.5 font-mono text-xs">
                <p className="rounded-md bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300">+ S7 Notify Slack</p>
                <p className="rounded-md bg-violet-500/10 px-2 py-1 text-violet-700 dark:text-violet-300">~ schedule → 0 9 * * 1</p>
              </div>
            </Feature>
            <Feature className="md:col-span-2" title="Safe by default" body="Secrets redacted on your machine, risky steps need approval, workflows get a read-only token, nothing runs until you run it.">
              <div className="flex flex-wrap gap-1.5 text-xs">
                {["redaction", "approval gates", "verified rollback", "read-only token", "shellcheck ✓", "actionlint ✓"].map((t) => (
                  <span key={t} className="rounded-full border border-line bg-surface-2 px-2.5 py-1">{t}</span>
                ))}
              </div>
            </Feature>
          </div>
        </section>

        {/* ---- try it ---- */}
        <section className="mx-auto w-full max-w-6xl px-4 pt-28 sm:px-6">
          <Reveal>
            <div className="card relative overflow-hidden p-8 sm:p-12">
              <div aria-hidden className="bg-glow absolute inset-0 opacity-80" />
              <div className="relative grid gap-8 md:grid-cols-[1.2fr_1fr] md:items-center">
                <div>
                  <p className="eyebrow">For judges · about a minute</p>
                  <h2 className="mt-3 text-3xl font-semibold tracking-tight">Try it with your own voice.</h2>
                  <p className="mt-3 max-w-lg text-muted">
                    Open the demo, pick a command, hold your Wispr key and say a reason. Watch it become a guard or a check in the
                    script. No sign-in, and nothing on the site touches a real server.
                  </p>
                  <Link href={`/s/${demo.id}`} className="btn btn-primary mt-6">Open the live demo <span aria-hidden>→</span></Link>
                </div>
                <ol className="space-y-3 text-sm">
                  {[
                    "Amber banner: the backup that was promised but never ran. Try Remove, then Keep.",
                    "Say it yourself: speak your own reason, see the new guard.",
                    "Talk to fix: apply the example correction, see v1 → v2.",
                    "Scroll to the sandbox proof and open the script tab.",
                  ].map((t, i) => (
                    <li key={t} className="flex gap-3">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft font-mono text-xs text-accent">{i + 1}</span>
                      <span className="pt-0.5">{t}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </Reveal>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

const STEPS = [
  { title: "Record", body: "Run the chore as usual. Secrets are redacted on your machine.", code: 'sayops start "renew cert"' },
  { title: "Say why", body: "After a command, type why and hold your Wispr key. Your reason attaches to it.", code: "why> always test the config…" },
  { title: "Compile", body: "Reasons become guards, conditions, checks and rollbacks. Gaps get flagged.", code: "sayops compile" },
  { title: "Prove & ship", body: "Run it in a sandbox, review what SayOps added, then take the script and workflow.", code: "npm run proof:ssl" },
];

function Stat({ value, label, note, accent }: { value: string; label: string; note: string; accent?: boolean }) {
  return (
    <div className="p-5 sm:p-6">
      <dt className="sr-only">{label}</dt>
      <dd className={`text-3xl font-semibold tracking-tight sm:text-4xl ${accent ? "text-amber-600 dark:text-amber-400" : ""}`}>{value}</dd>
      <dd className="mt-1 text-sm font-medium">{label}</dd>
      <dd className="text-xs text-muted">{note}</dd>
    </div>
  );
}

function Feature({ title, body, children, className = "" }: { title: string; body: string; children: ReactNode; className?: string }) {
  return (
    <Reveal className={className}>
      <article className="card flex h-full flex-col gap-4 p-6 transition-shadow hover:shadow-lg">
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
        </div>
        <div className="mt-auto">{children}</div>
      </article>
    </Reveal>
  );
}
