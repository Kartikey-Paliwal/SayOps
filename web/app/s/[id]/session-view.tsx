"use client";

import {
  assessReadiness, findingKey, slugify, sourceTexts,
  type AlignedSession, type Decision, type Finding, type Plan, type PlanStep, type ProofRun, type ProofScenario, type Readiness,
} from "@sayops/core";
import Link from "next/link";
import { useMemo, useState } from "react";

interface Props {
  sessionId: string;
  title: string;
  summary: string;
  shell: string;
  redacted: number;
  narrationCount: number;
  session: AlignedSession;
  plan: Plan;
  proof: ProofRun | null;
  proofMatchesScript: boolean;
}

export function SessionView(props: Props) {
  const { session, plan, sessionId } = props;
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [hover, setHover] = useState<string | null>(null);
  const sources = useMemo(() => sourceTexts(session), [session]);
  const kinds = useMemo(() => Object.fromEntries(plan.narrations.map((n) => [n.id, n.kind])), [plan]);
  const readiness = useMemo(
    () => assessReadiness({ plan, session, decisions, sessionId, version: 1 }),
    [plan, session, decisions, sessionId],
  );
  const decide = (f: Finding, d: Decision | null) =>
    setDecisions((prev) => {
      const next = { ...prev };
      if (d) next[findingKey(f)] = d;
      else delete next[findingKey(f)];
      return next;
    });

  const gaps = plan.findings.filter((f) => f.type === "said_not_done");
  const otherFindings = plan.findings.filter((f) => f.type !== "said_not_done");
  const commandCount = session.steps.length;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-6 sm:px-6">
      <nav className="text-sm">
        <Link href="/" className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← SayOps</Link>
      </nav>

      <header className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">Recorded session · {sessionId}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{props.title}</h1>
          <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-400">{props.summary}</p>
          <p className="mt-2 text-sm text-zinc-500">
            {commandCount} commands · {props.narrationCount} spoken reasons · {props.redacted} secret redacted before upload · {props.shell}
          </p>
        </div>
        <StatusBadge status={readiness.status} />
      </header>

      <Glance props={props} readiness={readiness} decisions={decisions} />

      {gaps.map((f) => (
        <SaidVsDid key={findingKey(f)} finding={f} plan={plan} sources={sources} decision={decisions[findingKey(f)]} onDecide={(d) => decide(f, d)} />
      ))}

      <ReadinessPanel readiness={readiness} />

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section aria-labelledby="timeline-h">
          <h2 id="timeline-h" className="text-lg font-semibold">What you did and said</h2>
          <p className="mt-1 text-sm text-zinc-500">Each spoken reason (dictated with Wispr Flow after <code className="font-mono">why</code>) is attached to the command before it.</p>
          <Timeline session={session} kinds={kinds} hover={hover} />
        </section>

        <section aria-labelledby="plan-h">
          <h2 id="plan-h" className="text-lg font-semibold">What SayOps built from it</h2>
          <p className="mt-1 text-sm text-zinc-500">Hover a source chip to see the command or sentence it came from.</p>
          <PlanView plan={readiness.plan} kinds={kinds} sources={sources} setHover={setHover} />
          {otherFindings.length > 0 && (
            <ul className="mt-4 space-y-2">
              {otherFindings.map((f) => (
                <li key={findingKey(f)} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
                  <b>{f.type.replace(/_/g, " ")}:</b> {f.detail}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <SandboxProof proof={props.proof} matches={props.proofMatchesScript} dismissed={Object.values(decisions).includes("dismissed")} />

      <ArtifactTabs title={plan.title} readiness={readiness} />

      <p className="mt-10 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-zinc-800">
        This demo uses a seeded session, its cached plan and a recorded sandbox run, so no AI key or Docker is needed to explore it. The live compiler
        (Groq <code className="font-mono">openai/gpt-oss-120b</code>) produces the same structure and is checked against this plan in
        the test suite. Nothing on this page connects to a real server; the generated script runs only where you run it.
      </p>
    </main>
  );
}

// ---- status ------------------------------------------------------------------------------

const STATUS: Record<Readiness["status"], { label: string; hint: string; cls: string }> = {
  ready: { label: "Ready", hint: "Safe to download and test in a sandbox", cls: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200" },
  needs_review: { label: "Needs review", hint: "Confirm what SayOps added", cls: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200" },
  blocked: { label: "Blocked", hint: "Not safe to use yet", cls: "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200" },
};

function StatusBadge({ status }: { status: Readiness["status"] }) {
  const s = STATUS[status];
  return (
    <div role="status" aria-live="polite" className={`shrink-0 rounded-xl border px-4 py-3 ${s.cls}`}>
      <p className="text-xs font-medium uppercase tracking-wider opacity-75">Automation status</p>
      <p className="text-xl font-semibold">{s.label}</p>
      <p className="text-xs opacity-80">{s.hint}</p>
    </div>
  );
}

// ---- said vs did -------------------------------------------------------------------------

function SaidVsDid({ finding, plan, sources, decision, onDecide }: {
  finding: Finding;
  plan: Plan;
  sources: Record<string, string>;
  decision?: Decision;
  onDecide: (d: Decision | null) => void;
}) {
  const said = finding.sources.filter((id) => id.startsWith("N")).map((id) => ({ id, text: sources[id] }));
  const step = plan.steps.find((s) => s.id === finding.fix_step);
  const restoreWhy = plan.rollback.find((r) => r.run.includes("sayops_restore"))?.why;
  const tone = decision === "accepted"
    ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40"
    : decision === "dismissed"
      ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
      : "border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40";

  return (
    <section aria-label="Said versus did" className={`mt-6 rounded-2xl border-2 p-5 sm:p-6 ${tone}`}>
      <p className="text-xs font-semibold uppercase tracking-widest text-amber-800 dark:text-amber-300">Said vs did · caught a missing step</p>
      <h2 className="mt-2 text-xl font-semibold sm:text-2xl">You said it. It never ran.</h2>
      {said.map((s) => (
        <blockquote key={s.id} className="mt-3 border-l-4 border-amber-400 pl-4 text-lg italic text-zinc-800 dark:text-zinc-200">
          “{s.text}” <span className="not-italic font-mono text-xs text-zinc-500">{s.id}</span>
        </blockquote>
      ))}
      <p className="mt-3 max-w-3xl text-sm text-zinc-700 dark:text-zinc-300">
        No command in this session did what you described.
        {restoreWhy && <> If a step had failed, the rollback you asked for (“{sources[restoreWhy]}”) would have had nothing to restore.</>}
      </p>
      {step && (
        <div className="mt-4 rounded-lg border border-zinc-300 bg-white/70 p-3 dark:border-zinc-700 dark:bg-zinc-900/60">
          <p className="text-sm font-medium">SayOps added step {step.id}: {step.intent}</p>
          <code className="mt-1 block break-all font-mono text-sm">{step.run}</code>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {decision ? (
          <>
            <p className="text-sm font-medium">
              {decision === "accepted" ? `Accepted: ${step?.id ?? "the step"} stays in the script.` : `Removed: ${step?.id ?? "the step"} is out of the plan.`}
            </p>
            <button type="button" onClick={() => onDecide(null)} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-900">
              Undo
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => onDecide("accepted")} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
              Keep step {step?.id}
            </button>
            <button type="button" onClick={() => onDecide("dismissed")} className="rounded-lg border border-zinc-400 px-4 py-2 text-sm font-medium hover:bg-white dark:border-zinc-600 dark:hover:bg-zinc-900">
              Remove it
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function ReadinessPanel({ readiness }: { readiness: Readiness }) {
  const { blockers, reviews, checks, status } = readiness;
  if (status === "ready" && checks.every((c) => c.ok)) {
    return (
      <p className="mt-4 text-sm text-emerald-800 dark:text-emerald-300">
        All {checks.length} safety checks pass and every step SayOps added has been reviewed.
      </p>
    );
  }
  return (
    <div className="mt-4 space-y-2 text-sm">
      {blockers.map((b) => (
        <p key={b} className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          <b>Blocked:</b> {b}
        </p>
      ))}
      {reviews.map((r) => (
        <p key={r.key} className="text-amber-900 dark:text-amber-200">
          <b>To review:</b> {r.text}
        </p>
      ))}
    </div>
  );
}

// ---- timeline ----------------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = {
  reason: "reason", condition: "condition", guard: "guard", verify: "check", rollback: "rollback",
  warning: "warning", param_hint: "changes per run", claim: "claim", context: "context",
};

function Timeline({ session, kinds, hover }: { session: AlignedSession; kinds: Record<string, string>; hover: string | null }) {
  const ring = (id: string) => (hover === id ? "ring-2 ring-sky-500" : "");
  return (
    <ol className="mt-4 space-y-3">
      {session.context.map((n) => (
        <li key={`N${n.seq}`} className={`rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-950 dark:bg-sky-950/50 dark:text-sky-100 ${ring(`N${n.seq}`)}`}>
          <Mic /> {n.text} <span className="font-mono text-xs opacity-60">N{n.seq}</span>
        </li>
      ))}
      {session.steps.map((s) => {
        const c = s.command;
        return (
          <li key={c.seq} className={`rounded-xl border border-zinc-200 p-3 dark:border-zinc-800 ${s.superseded ? "opacity-55" : ""} ${ring(`C${c.seq}`)}`}>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 font-mono text-xs text-zinc-400">C{c.seq}</span>
              <code className="min-w-0 flex-1 break-all font-mono text-sm">$ {c.cmd}</code>
              <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-xs ${c.exit === 0 ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"}`}>
                exit {c.exit}
              </span>
            </div>
            {s.superseded && <p className="mt-1 text-xs text-zinc-500">Typo, retried in the next command: left out of the plan.</p>}
            {s.narrations.map((n) => (
              <p key={n.seq} className={`mt-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-950 dark:bg-sky-950/50 dark:text-sky-100 ${ring(`N${n.seq}`)}`}>
                <Mic /> {n.text}{" "}
                <span className="whitespace-nowrap font-mono text-xs opacity-60">N{n.seq} · {KIND_LABEL[kinds[`N${n.seq}`]] ?? "reason"}</span>
              </p>
            ))}
          </li>
        );
      })}
    </ol>
  );
}

function Mic() {
  return (
    <svg aria-label="spoken" viewBox="0 0 16 16" className="mr-1 inline h-3.5 w-3.5 -translate-y-px fill-current opacity-70">
      <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1Zm-4.5 6a.75.75 0 0 1 .75.75 3.75 3.75 0 0 0 7.5 0 .75.75 0 0 1 1.5 0 5.25 5.25 0 0 1-4.5 5.2V14h1.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5h1.5v-1.05a5.25 5.25 0 0 1-4.5-5.2A.75.75 0 0 1 3.5 7Z" />
    </svg>
  );
}

// ---- plan --------------------------------------------------------------------------------

const RISK: Record<PlanStep["risk"], string> = {
  LOW: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  MEDIUM: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  HIGH: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
};

function Chip({ children, cls }: { children: React.ReactNode; cls: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

function SourceChips({ ids, sources, setHover }: { ids: string[]; sources: Record<string, string>; setHover: (id: string | null) => void }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          title={sources[id]}
          onMouseEnter={() => setHover(id)}
          onMouseLeave={() => setHover(null)}
          onFocus={() => setHover(id)}
          onBlur={() => setHover(null)}
          className={`rounded border px-1.5 font-mono text-xs ${id.startsWith("N") ? "border-sky-300 text-sky-800 dark:border-sky-800 dark:text-sky-300" : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"}`}
        >
          {id}
        </button>
      ))}
    </span>
  );
}

function PlanView({ plan, kinds, sources, setHover }: { plan: Plan; kinds: Record<string, string>; sources: Record<string, string>; setHover: (id: string | null) => void }) {
  return (
    <div className="mt-4 space-y-3">
      {plan.params.length > 0 && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Parameters:{" "}
          {plan.params.map((p) => (
            <code key={p.name} className="mr-2 font-mono text-xs">
              {p.name} <span className="text-zinc-400">(was {p.from})</span>
            </code>
          ))}
        </p>
      )}
      <ol className="space-y-3">
        {plan.steps.map((s) => {
          const guarded = s.sources.some((id) => kinds[id] === "guard");
          return (
            <li key={s.id} className={`rounded-xl border p-3 ${s.added ? "border-amber-400 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/30" : "border-zinc-200 dark:border-zinc-800"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-zinc-500">{s.id}</span>
                <span className="font-medium">{s.intent}</span>
                <Chip cls={RISK[s.risk]}>{s.risk.toLowerCase()} risk</Chip>
                {s.added && <Chip cls="bg-amber-200 text-amber-950 dark:bg-amber-800 dark:text-amber-50">added by SayOps</Chip>}
                {guarded && <Chip cls="bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200">guard</Chip>}
                {s.on_fail === "abort_and_rollback" && <Chip cls="bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200">rolls back on failure</Chip>}
              </div>
              <code className="mt-2 block break-all rounded-md bg-zinc-50 px-2 py-1.5 font-mono text-sm dark:bg-zinc-900">{s.run}</code>
              {s.condition && (
                <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
                  <Chip cls="bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">condition</Chip>{" "}
                  Skip {s.condition.scope === "all" ? "the whole task" : "this step"} when{" "}
                  <code className="break-all font-mono text-xs">{s.condition.skip_if}</code> succeeds{" "}
                  <SourceChips ids={[s.condition.why]} sources={sources} setHover={setHover} />
                </p>
              )}
              <p className="mt-2 text-xs text-zinc-500">
                from <SourceChips ids={s.sources} sources={sources} setHover={setHover} />
              </p>
            </li>
          );
        })}
      </ol>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-sm font-medium">If a guarded step fails: roll back</p>
          {plan.rollback.length ? plan.rollback.map((r, i) => (
            <p key={i} className="mt-2 text-sm"><code className="break-all font-mono">{r.run}</code> <SourceChips ids={[r.why]} sources={sources} setHover={setHover} /></p>
          )) : <p className="mt-2 text-sm text-zinc-500">No rollback described.</p>}
        </div>
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-sm font-medium">At the end: verify</p>
          {plan.verify.length ? plan.verify.map((v, i) => (
            <p key={i} className="mt-2 text-sm"><code className="break-all font-mono">{v.run}</code> <SourceChips ids={[v.why]} sources={sources} setHover={setHover} /></p>
          )) : <p className="mt-2 text-sm text-zinc-500">No verification described.</p>}
        </div>
      </div>
    </div>
  );
}

// ---- artifacts ---------------------------------------------------------------------------

const TABS = [
  { key: "script", label: "Bash script", ext: "sh" },
  { key: "workflow", label: "GitHub workflow", ext: "yml" },
  { key: "runbook", label: "Runbook", ext: "md" },
] as const;

function ArtifactTabs({ title, readiness }: { title: string; readiness: Readiness }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("script");
  const [copied, setCopied] = useState(false);
  const { artifacts, checks } = readiness;
  const current = TABS.find((t) => t.key === tab)!;
  const text = artifacts?.[tab] ?? "";
  const filename = tab === "runbook" ? "RUNBOOK.md" : `${slugify(title)}.${current.ext}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section aria-labelledby="artifacts-h" className="mt-10">
      <h2 id="artifacts-h" className="text-lg font-semibold">Generated automation</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Rendered deterministically from the plan, not written freehand by the AI. Each step keeps its source reference.
      </p>
      {checks.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Safety checks">
          {checks.map((c) => (
            <li key={c.id} title={c.detail} className={`rounded-full px-2.5 py-1 text-xs ${c.ok ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" : "bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300"}`}>
              {c.ok ? "✓" : "✗"} {c.label}
            </li>
          ))}
        </ul>
      )}
      {!artifacts ? (
        <p className="mt-4 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          Nothing is generated while the plan is blocked. Resolve the blockers above (or undo the removal) to get the script back.
        </p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 bg-zinc-50 p-1.5 dark:border-zinc-800 dark:bg-zinc-900" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-lg px-3 py-1.5 text-sm ${tab === t.key ? "bg-white font-medium shadow-sm dark:bg-zinc-800" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"}`}
              >
                {t.label}
              </button>
            ))}
            <span className="ml-auto flex gap-1">
              <button type="button" onClick={copy} className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-white dark:text-zinc-300 dark:hover:bg-zinc-800">{copied ? "Copied" : "Copy"}</button>
              <button type="button" onClick={download} className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-white dark:text-zinc-300 dark:hover:bg-zinc-800">Download {filename}</button>
            </span>
          </div>
          <pre role="tabpanel" className="max-h-[32rem] overflow-auto bg-white p-4 font-mono text-xs leading-relaxed dark:bg-zinc-950">{text}</pre>
        </div>
      )}
    </section>
  );
}

// ---- at a glance -------------------------------------------------------------------------

function Glance({ props, readiness, decisions }: { props: Props; readiness: Readiness; decisions: Record<string, Decision> }) {
  const { session, plan, proof, proofMatchesScript } = props;
  const dropped = session.steps.filter((s) => s.superseded).length;
  const gaps = plan.findings.filter((f) => f.type !== "param_suggest");
  const open = gaps.filter((f) => !decisions[findingKey(f)]).length;
  const passed = proof?.scenarios.filter((s) => s.passed).length ?? 0;
  const cards: { label: string; value: string; note: string; tone?: "warn" | "good" | "bad" }[] = [
    { label: "Said", value: String(props.narrationCount), note: "spoken reasons, dictated with Wispr Flow" },
    { label: "Observed", value: String(session.steps.length - dropped), note: dropped ? `commands run · ${dropped} typo dropped` : "commands run" },
    { label: "Proposed", value: String(readiness.plan.steps.length), note: `steps · ${plan.rollback.length} rollback · ${plan.verify.length} check` },
    { label: "Safety gaps", value: String(gaps.length), note: open ? `${open} waiting for your review` : gaps.length ? "all reviewed" : "none found", tone: open ? "warn" : "good" },
    {
      label: "Sandbox proved",
      value: proof ? `${passed}/${proof.scenarios.length}` : "—",
      note: !proof ? "not run yet" : proofMatchesScript ? "scenarios, same script as below" : "recorded for an older script",
      tone: !proof || !proofMatchesScript ? "warn" : passed === proof.scenarios.length ? "good" : "bad",
    },
  ];
  const tone = { warn: "text-amber-700 dark:text-amber-300", good: "text-emerald-700 dark:text-emerald-300", bad: "text-red-700 dark:text-red-300" };
  return (
    <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 sm:grid-cols-5 dark:border-zinc-800 dark:bg-zinc-800">
      {cards.map((c) => (
        <div key={c.label} className="bg-white p-3 dark:bg-zinc-950">
          <dt className="text-xs font-medium uppercase tracking-wider text-zinc-500">{c.label}</dt>
          <dd className={`mt-1 text-2xl font-semibold ${c.tone ? tone[c.tone] : ""}`}>{c.value}</dd>
          <dd className="text-xs text-zinc-500">{c.note}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---- sandbox proof -----------------------------------------------------------------------

const STEP_ICON: Record<string, { icon: string; cls: string; label: string }> = {
  ok: { icon: "✓", cls: "text-emerald-700 dark:text-emerald-400", label: "ok" },
  failed: { icon: "✗", cls: "text-red-700 dark:text-red-400", label: "failed" },
  skipped: { icon: "–", cls: "text-zinc-500", label: "skipped" },
  not_run: { icon: "·", cls: "text-zinc-400", label: "not run" },
};

const EXIT_MEANING: Record<number, string> = {
  0: "done or nothing to do",
  1: "stopped, no rollback",
  4: "rolled back, recovery NOT verified",
  5: "rolled back, recovery verified",
};

function SandboxProof({ proof, matches, dismissed }: { proof: ProofRun | null; matches: boolean; dismissed: boolean }) {
  return (
    <section aria-labelledby="proof-h" className="mt-10">
      <h2 id="proof-h" className="text-lg font-semibold">What the sandbox proved</h2>
      {!proof ? (
        <p className="mt-2 text-sm text-zinc-500">No sandbox run has been recorded for this session yet.</p>
      ) : (
        <>
          <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
            The generated script was run for real against a throwaway web server (real nginx, openssl and curl; stand-ins for
            certbot and systemctl) in a Docker container with no network. Results are recorded, not live: this website never runs commands.
            After each run the sandbox was inspected independently, without trusting what the script said.
          </p>
          <p className={`mt-2 text-xs ${matches && !dismissed ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300"}`}>
            {dismissed
              ? "You removed a step SayOps added, so this proof no longer describes the plan above."
              : matches
                ? `Proven script matches the script below (sha256 ${proof.scriptSha256.slice(0, 12)}…).`
                : "The script below has changed since this proof was recorded. Re-run: npm run proof:ssl -w @sayops/core"}
            {" "}Recorded {new Date(proof.generatedAt).toUTCString()} · Docker {proof.environment.docker} · image {proof.environment.imageId}
          </p>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {proof.scenarios.map((s) => <ScenarioCard key={s.id} s={s} />)}
          </div>
          <details className="mt-3 text-xs text-zinc-500">
            <summary className="cursor-pointer">Sandbox isolation</summary>
            <ul className="mt-1 list-disc pl-5">{proof.environment.isolation.map((i) => <li key={i} className="font-mono">{i}</li>)}</ul>
            <p className="mt-1">Parameters: {Object.entries(proof.params).map(([k, v]) => `${k}=${v}`).join(" · ")}</p>
          </details>
        </>
      )}
    </section>
  );
}

function ScenarioCard({ s }: { s: ProofScenario }) {
  return (
    <article className={`flex flex-col rounded-xl border p-4 ${s.passed ? "border-emerald-300 dark:border-emerald-800" : "border-red-300 dark:border-red-800"}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium">{s.title}</h3>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${s.passed ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" : "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200"}`}>
          {s.passed ? "proved" : "did not prove"}
        </span>
      </div>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{s.setup}</p>
      <p className="mt-1 text-sm"><b>Expected:</b> {s.expectation}</p>
      <p className="mt-2 font-mono text-xs text-zinc-500">
        exit {s.exitCode} ({EXIT_MEANING[s.exitCode] ?? "unexpected"}) · expected {s.expectedExit} · {(s.durationMs / 1000).toFixed(1)}s
      </p>

      <ol className="mt-3 space-y-1 text-sm">
        {s.steps.map((st) => {
          const icon = STEP_ICON[st.status];
          return (
            <li key={st.id}>
              <details>
                <summary className="cursor-pointer list-none">
                  <span className={`inline-block w-4 font-mono ${icon.cls}`} aria-label={icon.label}>{icon.icon}</span>
                  <span className="font-mono text-xs text-zinc-500">{st.id}</span> {st.intent}
                  {st.status === "failed" && <span className="text-red-700 dark:text-red-400"> (exit {st.exitCode})</span>}
                </summary>
                {st.output.length > 0 ? (
                  <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-50 p-2 font-mono text-[11px] leading-snug dark:bg-zinc-900">{st.output.join("\n")}</pre>
                ) : (
                  <p className="ml-4 mt-1 text-xs text-zinc-500">Not executed{s.skippedAll ? ` (task skipped by ${s.skippedAll}'s condition)` : ""}.</p>
                )}
              </details>
            </li>
          );
        })}
      </ol>

      {s.rollback.ran && (
        <div className="mt-3 rounded-lg bg-sky-50 p-2 text-sm dark:bg-sky-950/40">
          <p><b>Rollback:</b> {s.rollback.commands.map((c) => `${c.ok ? "✓" : "✗"} ${c.command}`).join(" · ")}</p>
          <p className="mt-1"><b>Recovery:</b> {s.recovery === "verified" ? "verified by the plan's checks after rollback" : "NOT verified"}</p>
        </div>
      )}

      <ul className="mt-3 space-y-1 text-xs" aria-label="Independent checks">
        {s.checks.map((c) => (
          <li key={c.label} className={c.ok ? "text-emerald-800 dark:text-emerald-300" : "text-red-800 dark:text-red-300"} title={`expected ${c.expected}, got ${c.actual}`}>
            {c.ok ? "✓" : "✗"} {c.label}
          </li>
        ))}
      </ul>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-zinc-500">Full recorded output ({s.log.length} lines)</summary>
        <pre className="mt-1 max-h-72 overflow-auto rounded bg-zinc-50 p-2 font-mono text-[11px] leading-snug dark:bg-zinc-900">{s.log.join("\n")}</pre>
      </details>
    </article>
  );
}
