import type { Plan, SessionEvent, SessionMeta } from "../schemas";
import { sslRenewEvents, sslRenewMeta } from "./ssl-renew";
import { sslRenewPlan } from "./ssl-renew.plan";
import { sslRenewProof } from "./ssl-renew.proof";
import { sslRenewCorrection, type CorrectionExample } from "./ssl-renew.correction";
import { sslRenewReasons, type ReasonExample } from "./ssl-renew.reasons";
import type { ProofRun } from "../proof";

export interface Seed {
  id: string;
  meta: SessionMeta;
  /** raw events, before redaction (redaction runs exactly as it would on upload) */
  events: SessionEvent[];
  /** cached plan, so the demo needs no LLM key; the live compiler is tested against it */
  plan: Plan;
  summary: string;
  /** recorded sandbox proof of the generated script, or null if it has not been run */
  proof: ProofRun | null;
  /** a real talk-to-fix result recorded from a live compile, shown as an example */
  correction: CorrectionExample | null;
  /** real "say it yourself" results recorded from live compiles, offered as one-click examples */
  reasons: ReasonExample[];
}

export const SEEDS: Seed[] = [
  {
    id: "ssl-renew",
    meta: sslRenewMeta,
    events: sslRenewEvents,
    plan: sslRenewPlan,
    summary: "Renew an expiring certificate on a web server: stop nginx, renew, test the config, start, check the site.",
    proof: sslRenewProof,
    correction: sslRenewCorrection,
    reasons: sslRenewReasons,
  },
];

export function getSeed(id: string): Seed | undefined {
  return SEEDS.find((s) => s.id === id);
}
