import type { SessionEvent } from "./schemas";

interface Rule {
  type: string;
  re: RegExp;
  /** capture group holding the secret; whole match when omitted */
  group?: number;
  /** secret is a VALUE (three alternative groups starting at `group`) */
  value?: boolean;
}

/** 'quoted', "quoted" or bare value → three capture groups */
const VALUE = `(?:'([^']+)'|"([^"]+)"|([^\\s"']+))`;

const RULES: Rule[] = [
  { type: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { type: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { type: "gitlab_token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { type: "aws_key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { type: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { type: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { type: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // scheme://user:PASSWORD@host
  { type: "conn_password", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@<>]+:([^\s@<>]+)@/gi, group: 1 },
  // --password X, --password=X, -p'X', PASSWORD=X, token: X, Authorization: Bearer X
  { type: "password", re: new RegExp(`--?(?:password|passwd|pass|token|secret|api-key)[=\\s]+${VALUE}`, "gi"), group: 1, value: true },
  { type: "env_secret", re: new RegExp(`\\b[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY)[A-Z0-9_]*=${VALUE}`, "g"), group: 1, value: true },
  { type: "bearer", re: /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 1 },
];

/**
 * Long high-entropy strings that no rule caught (hex/base64 blobs). "/" is deliberately not
 * part of a token: otherwise a whole file path (e.g. macOS /var/folders/9d/…/T) reads as one blob.
 */
const BLOB = /(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_=-]{32,}(?![A-Za-z0-9+_=-])/g;

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

export interface RedactResult {
  text: string;
  found: string[]; // redaction types, one per hit
}

export function redactText(input: string): RedactResult {
  const found: string[] = [];
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.re, (match, ...groups) => {
      if (rule.group === undefined) {
        found.push(rule.type);
        return `<REDACTED:${rule.type}>`;
      }
      const span = rule.value ? 3 : 1;
      const secret = groups.slice(rule.group - 1, rule.group - 1 + span).find((g) => typeof g === "string") as string | undefined;
      if (!secret || secret.startsWith("<REDACTED:") || secret.startsWith("$")) return match;
      found.push(rule.type);
      return match.replace(secret, `<REDACTED:${rule.type}>`);
    });
  }
  text = text.replace(BLOB, (m) => {
    if (m.includes("REDACTED") || /^[a-z0-9-]+$/.test(m) || entropy(m) < 4.0) return m;
    found.push("high_entropy");
    return "<REDACTED:high_entropy>";
  });
  return { text, found };
}

/** Redacts every command and narration. Runs locally before anything is uploaded. */
export function redactEvents(events: SessionEvent[]): { events: SessionEvent[]; count: number } {
  let count = 0;
  const out = events.map((e) => {
    if (e.kind === "command") {
      const r = redactText(e.cmd);
      count += r.found.length;
      return { ...e, cmd: r.text };
    }
    const r = redactText(e.text);
    count += r.found.length;
    return { ...e, text: r.text };
  });
  return { events: out, count };
}
