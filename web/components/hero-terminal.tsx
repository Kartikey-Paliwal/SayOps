"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * The SSL demo session told as a terminal: commands are typed, each `why` shows a voice waveform
 * (dictated with Wispr Flow), then what SayOps made of it. Loops; shows the final frame when the
 * visitor prefers reduced motion.
 */
type Beat =
  | { kind: "cmd"; text: string }
  | { kind: "why"; text: string }
  | { kind: "out"; text: string; tone: "accent" | "green" | "muted" | "amber" };

const BEATS: Beat[] = [
  { kind: "cmd", text: 'sayops start "Renew SSL certificate"' },
  { kind: "out", text: "● recording so_7f2a · type why after a command", tone: "accent" },
  { kind: "cmd", text: "ssh web-1 'sudo systemctl stop nginx'" },
  { kind: "why", text: "Stop nginx because certbot needs port 80." },
  { kind: "out", text: "  ↳ N3 · reason · explains C3", tone: "muted" },
  { kind: "cmd", text: "ssh web-1 'sudo certbot renew'" },
  { kind: "why", text: "Before this I always back up the old cert folder." },
  { kind: "cmd", text: "ssh web-1 'sudo nginx -t'" },
  { kind: "why", text: "Always test the config before starting, or the site goes down." },
  { kind: "out", text: "  ↳ N5 · guard · the run stops and rolls back if it fails", tone: "accent" },
  { kind: "cmd", text: "sayops stop" },
  { kind: "out", text: "✔ 7 commands · 7 reasons · 1 secret redacted", tone: "green" },
  { kind: "out", text: "⚠ said vs did: you said you back up first, but no backup ran. Added it for review.", tone: "amber" },
];

const TONE = {
  accent: "text-violet-300",
  green: "text-emerald-300",
  muted: "text-zinc-400",
  amber: "text-amber-300",
};

export function HeroTerminal() {
  const [beat, setBeat] = useState(0);
  const [chars, setChars] = useState(0);
  const [listening, setListening] = useState(false);
  const still = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);

  useEffect(() => {
    if (still) return;
    if (beat >= BEATS.length) {
      const t = setTimeout(() => { setBeat(0); setChars(0); }, 5000);
      return () => clearTimeout(t);
    }
    const b = BEATS[beat];
    if (b.kind === "out") {
      const t = setTimeout(() => { setBeat((x) => x + 1); setChars(0); }, 650);
      return () => clearTimeout(t);
    }
    if (b.kind === "why" && chars === 0 && !listening) {
      const t = setTimeout(() => setListening(true), 350);
      return () => clearTimeout(t);
    }
    if (b.kind === "why" && listening) {
      const t = setTimeout(() => { setListening(false); setChars(1); }, 1100);
      return () => clearTimeout(t);
    }
    if (chars < b.text.length) {
      const t = setTimeout(() => setChars((c) => c + (b.kind === "why" ? 3 : 1)), b.kind === "why" ? 22 : 30);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => { setBeat((x) => x + 1); setChars(0); }, 500);
    return () => clearTimeout(t);
  }, [beat, chars, listening, still]);

  const done = still ? BEATS.length : beat;
  const lines = BEATS.slice(0, Math.min(done + 1, BEATS.length)).map((b, i) => {
    const active = !still && i === beat;
    const text = active && b.kind !== "out" ? b.text.slice(0, chars) : b.text;
    return { b, text, active };
  });

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 text-left shadow-2xl shadow-violet-900/20 ring-1 ring-white/5">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 font-mono text-xs text-zinc-500">zsh — renewing a certificate, out loud</span>
      </div>
      <div className="flex h-[22rem] flex-col justify-end overflow-hidden px-4 py-4 font-mono text-[12.5px] leading-6 sm:text-[13px]" aria-label="Animated example of a SayOps recording" role="img">
        {lines.map(({ b, text, active }, i) => (
          <div key={i} className="animate-fade-in whitespace-pre-wrap break-words">
            {b.kind === "cmd" && (
              <p className="text-zinc-100">
                <span className="text-emerald-400">$</span> {text}
                {active && <span className="caret ml-0.5 text-zinc-400" />}
              </p>
            )}
            {b.kind === "why" && (
              <p className="text-zinc-100">
                <span className="text-emerald-400">$</span> why
                <br />
                <span className="text-violet-300">why&gt; </span>
                {active && listening ? (
                  <span className="inline-flex items-center gap-2 text-violet-300">
                    <span className="wave inline-flex items-center"><span /><span /><span /><span /><span /></span>
                    <span className="text-xs text-zinc-500">holding fn · Wispr Flow is listening</span>
                  </span>
                ) : (
                  <span className="text-violet-100">{text}{active && <span className="caret ml-0.5 text-violet-300" />}</span>
                )}
              </p>
            )}
            {b.kind === "out" && <p className={`animate-pop ${TONE[b.tone]}`}>{text}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

const QUERY = "(prefers-reduced-motion: reduce)";
function prefersReducedMotion() {
  return window.matchMedia(QUERY).matches;
}
function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
