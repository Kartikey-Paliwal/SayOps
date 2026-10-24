import type { AlignedSession } from "./align";
import type { Finding, NarrationEvent, Plan } from "./schemas";

/**
 * Deterministic Said-vs-Did backstop. The LLM is asked to find gaps, but the demo's key
 * moment must not depend on it: a narration that claims a habitual action ("I always back
 * up first") with no command that performs it is always reported.
 */

interface Action {
  id: string;
  label: string;
  /** how the engineer says it */
  said: RegExp;
  /** what a command doing it looks like */
  done: RegExp;
}

const ACTIONS: Action[] = [
  {
    id: "backup", label: "a backup",
    said: /\b(back(?:ing)?[ -]?up|backups?|snapshot|make a copy|copy (?:of )?the|save a copy|dump)\b/i,
    done: /\b(cp|rsync|tar|zip|pg_dump|pg_basebackup|mysqldump|mongodump|snapshot|backup)\b|\.bak\b/i,
  },
  {
    id: "notify", label: "a notification",
    said: /\b(notify|post (?:it )?(?:to|in) slack|message (?:the )?team|tell (?:the )?team|ping|announce)\b/i,
    done: /\b(slack|webhook|notify|mail|sendmail|curl\b.*hooks\.)/i,
  },
  {
    id: "drain", label: "draining traffic",
    said: /\b(drain|take (?:it )?out of (?:the )?(?:pool|load ?balancer)|maintenance mode)\b/i,
    done: /\b(drain|cordon|maintenance|deregister)\b/i,
  },
];

/** Habit/intent phrasing — "I always…", "before this I…", "make sure to…". */
const CLAIM = /\b(always|usually|normally|every time|before (?:this|that|doing|i|we)|first (?:i|we)|make sure (?:to|i|we)|i'll|i will|we always|don't forget|never forget)\b/i;

export interface Gap {
  narration: NarrationEvent;
  action: Action;
}

export function findGaps(session: AlignedSession): Gap[] {
  const narrations = [...session.context, ...session.steps.flatMap((s) => s.narrations)];
  const commands = session.steps.filter((s) => !s.superseded).map((s) => s.command.cmd);
  const gaps: Gap[] = [];
  for (const n of narrations) {
    if (!CLAIM.test(n.text)) continue;
    for (const action of ACTIONS) {
      if (action.said.test(n.text) && !commands.some((c) => action.done.test(c))) gaps.push({ narration: n, action });
    }
  }
  return gaps;
}

/** Gaps the plan does not report yet (no said_not_done finding citing that narration). */
export function missingGaps(plan: Plan, gaps: Gap[]): Gap[] {
  return gaps.filter(
    (g) => !plan.findings.some((f) => f.type === "said_not_done" && f.sources.includes(`N${g.narration.seq}`)),
  );
}

export function gapRetryMessage(g: Gap): string {
  const id = `N${g.narration.seq}`;
  return `${id} says ${JSON.stringify(g.narration.text)} but no command performs ${g.action.label}: classify ${id} as "claim", add a "said_not_done" finding citing ${id}, and insert the missing step with "added": true and fix_step pointing to it`;
}

/** Last resort after the retry: report the gap even though no fix step was generated. */
export function gapFinding(g: Gap): Finding {
  return {
    type: "said_not_done",
    detail: `You said “${g.narration.text}” but no command did ${g.action.label}. Add it before trusting this script.`,
    sources: [`N${g.narration.seq}`],
    fix_step: null,
  };
}
