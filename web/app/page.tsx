import { SEEDS } from "@sayops/core";
import Link from "next/link";

export default function Home() {
  const demo = SEEDS[0];
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-20">
      <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">SayOps</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Narrate once, automate forever.</h1>
      <p className="mt-5 text-lg text-zinc-600 dark:text-zinc-400">
        Do an ops chore once in your terminal. After each command, type <code className="font-mono text-base">why</code>, hold your
        Wispr Flow key and say the reason. SayOps turns what you did <em>and why</em> into a guarded script, a GitHub workflow and a
        runbook, and catches the steps you said you&apos;d do but never ran.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          href={`/s/${demo.id}`}
          className="rounded-xl bg-zinc-900 px-5 py-3 font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Open the SSL renewal demo →
        </Link>
      </div>

      <ol className="mt-12 grid gap-4 sm:grid-cols-3">
        {[
          ["1 · Record", "Run the chore as usual. Speak the reason after each command; secrets are redacted on your machine."],
          ["2 · Compile", "Your reasons become checks, conditions and rollbacks. Anything you said but didn't do is flagged."],
          ["3 · Review", "Confirm what SayOps added, then take the script, workflow and runbook. Nothing runs until you run it."],
        ].map(([h, t]) => (
          <li key={h} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <p className="font-medium">{h}</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{t}</p>
          </li>
        ))}
      </ol>

      <section className="mt-12 rounded-xl border border-sky-200 bg-sky-50 p-5 text-sm text-sky-950 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
        <h2 className="font-semibold">For judges (about 1 minute)</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>No sign-in and no setup. The demo is a recorded certificate renewal with seven spoken reasons.</li>
          <li>Look at the amber banner: the engineer said they always back up first, but never did. Try <b>Remove it</b>, then <b>Keep step</b>, and watch the status change.</li>
          <li>Hover a source chip (C3, N5…) on any step to see the exact command or sentence it came from.</li>
          <li>Open the Bash script tab: every guard and rollback is annotated with the sentence that produced it.</li>
          <li>Nothing here connects to a real server.</li>
        </ul>
      </section>
    </main>
  );
}
