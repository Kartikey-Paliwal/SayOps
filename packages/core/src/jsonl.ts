import { SessionEvent } from "./schemas";

export function parseJsonl(src: string): SessionEvent[] {
  return src
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      const r = SessionEvent.safeParse(JSON.parse(l));
      if (!r.success) throw new Error(`line ${i + 1}: ${r.error.issues[0]?.message}`);
      return r.data;
    });
}
