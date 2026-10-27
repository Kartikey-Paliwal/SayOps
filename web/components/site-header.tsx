import Link from "next/link";
import { Logo } from "./logo";

const GITHUB = "https://github.com/Kartikey-Paliwal/SayOps";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-background/75 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="SayOps home">
          <Logo />
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1 text-sm">
          <Link href="/#how" className="hidden rounded-lg px-3 py-1.5 text-muted hover:text-foreground sm:inline-block">How it works</Link>
          <Link href="/#features" className="hidden rounded-lg px-3 py-1.5 text-muted hover:text-foreground sm:inline-block">Features</Link>
          <a href={GITHUB} className="hidden rounded-lg px-3 py-1.5 text-muted hover:text-foreground sm:inline-block">GitHub</a>
          <Link href="/s/ssl-renew" className="btn btn-primary ml-1 !px-3 !py-1.5 text-sm">Live demo</Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <Logo className="text-foreground" />
        <p>Built by voice with Wispr Flow for the No Hands challenge. Nothing on this site connects to a real server.</p>
        <a href={GITHUB} className="hover:text-foreground">GitHub ↗</a>
      </div>
    </footer>
  );
}
