import type { Plan, Risk } from "./schemas";

export interface RadarRule {
  id: string;
  risk: Exclude<Risk, "LOW">;
  re: RegExp;
  protection: string;
}

export const RADAR_RULES: RadarRule[] = [
  { id: "rm_rf", risk: "HIGH", re: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR]|-r\s+-f|-f\s+-r|--recursive)\b/, protection: "confirm gate; narrow the path" },
  { id: "find_delete", risk: "HIGH", re: /\bfind\b.*\s-delete\b/, protection: "confirm gate; narrow the match" },
  { id: "sql_drop", risk: "HIGH", re: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE)\b/i, protection: "confirm gate; back up first" },
  { id: "sql_delete_all", risk: "HIGH", re: /\bDELETE\s+FROM\s+\S+\s*(?:;|$|["'])/i, protection: "confirm gate; add a WHERE" },
  { id: "kubectl_delete", risk: "HIGH", re: /\bkubectl\s+delete\b/, protection: "approval environment" },
  { id: "terraform_destroy", risk: "HIGH", re: /\bterraform\s+destroy\b/, protection: "approval environment" },
  { id: "helm_uninstall", risk: "HIGH", re: /\bhelm\s+(?:uninstall|delete)\b/, protection: "approval environment" },
  { id: "dd_mkfs", risk: "HIGH", re: /\b(?:mkfs(?:\.\w+)?|dd\s+.*\bof=\/dev\/)/, protection: "confirm gate" },
  { id: "service_stop", risk: "MEDIUM", re: /\b(?:systemctl|service)\s+(?:\S+\s+)?(?:stop|restart)\b/, protection: "health check after; rollback" },
  { id: "reboot", risk: "MEDIUM", re: /\b(?:reboot|shutdown)\b/, protection: "health check after" },
  { id: "chmod_777", risk: "MEDIUM", re: /\bchmod\s+(?:-R\s+)?777\b/, protection: "warning" },
  { id: "curl_pipe_sh", risk: "MEDIUM", re: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, protection: "warning" },
];

const RANK: Record<Risk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function scan(cmd: string): RadarRule[] {
  return RADAR_RULES.filter((r) => r.re.test(cmd));
}

export function maxRisk(a: Risk, b: Risk): Risk {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Raises (never lowers) each step's risk from the deterministic rules, and adds an
 * `unexplained_danger` finding for HIGH steps that no narration or correction explains.
 */
export function applyRadar(plan: Plan): { plan: Plan; hits: Record<string, string[]> } {
  const hits: Record<string, string[]> = {};
  const findings = [...plan.findings];
  const steps = plan.steps.map((step) => {
    const rules = scan(step.run);
    if (!rules.length) return step;
    hits[step.id] = rules.map((r) => r.id);
    const risk = rules.reduce<Risk>((acc, r) => maxRisk(acc, r.risk), step.risk);
    const explained = step.sources.some((s) => s.startsWith("N") || s.startsWith("X"));
    const already = findings.some((f) => f.type === "unexplained_danger" && f.fix_step === step.id);
    if (risk === "HIGH" && !explained && !already) {
      findings.push({
        type: "unexplained_danger",
        detail: `"${step.run}" is destructive and nothing you said explains it. A confirmation gate was added.`,
        sources: step.sources,
        fix_step: step.id,
      });
    }
    return { ...step, risk };
  });
  return { plan: { ...plan, steps, findings }, hits };
}
