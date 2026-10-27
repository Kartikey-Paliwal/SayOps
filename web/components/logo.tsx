/** SayOps mark: a speech bubble whose tail is a terminal prompt. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <svg viewBox="0 0 24 24" aria-hidden className="h-6 w-6">
        <rect x="2" y="3" width="20" height="15" rx="5" className="fill-[var(--accent)]" />
        <path d="M7 19.5 9.5 18H7z" className="fill-[var(--accent)]" />
        <path d="m7 8 3 2.5L7 13" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12.5 13h4.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <span>SayOps</span>
    </span>
  );
}
