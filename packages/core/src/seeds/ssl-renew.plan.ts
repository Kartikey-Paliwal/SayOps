import type { Plan } from "../schemas";

/** Reference plan for the SSL seed: what a correct compile produces. Cached for judge mode. */
export const sslRenewPlan: Plan = {
  title: "Renew SSL certificate",
  schedule: null,
  remote_host: "HOST",
  params: [
    { name: "HOST", from: "web-1", why: "N1", validate: "^[a-zA-Z0-9.-]+$" },
    { name: "DOMAIN", from: "shop.example.com", why: "N1", validate: "^[a-zA-Z0-9.-]+$" },
    { name: "AUTH_TOKEN", from: "<REDACTED:bearer>", why: "C7", validate: null },
  ],
  narrations: [
    { id: "N1", kind: "param_hint" },
    { id: "N2", kind: "condition" },
    { id: "N3", kind: "reason" },
    { id: "N4", kind: "claim" },
    { id: "N5", kind: "guard" },
    { id: "N6", kind: "rollback" },
    { id: "N7", kind: "verify" },
  ],
  steps: [
    {
      id: "S1", intent: "Check when the certificate expires", run: 'sudo certbot certificates -d "$DOMAIN"',
      remote: true, sources: ["C1", "N2"], added: false,
      condition: {
        skip_if: 'sudo openssl x509 -checkend 2592000 -noout -in "/etc/letsencrypt/live/$DOMAIN/cert.pem"',
        remote: true, scope: "all", why: "N2",
      },
      on_fail: "abort", risk: "LOW",
    },
    {
      id: "S2", intent: "Stop nginx so certbot can use port 80", run: "sudo systemctl stop nginx",
      remote: true, sources: ["C3", "N3"], added: false, condition: null, on_fail: "abort_and_rollback", risk: "MEDIUM",
    },
    {
      id: "S3", intent: "Back up the current certificates", run: "sayops_backup /etc/letsencrypt",
      remote: true, sources: ["N4"], added: true, condition: null, on_fail: "abort_and_rollback", risk: "LOW",
    },
    {
      id: "S4", intent: "Renew the certificate", run: 'sudo certbot renew --cert-name "$DOMAIN"',
      remote: true, sources: ["C4", "N4"], added: false, condition: null, on_fail: "abort_and_rollback", risk: "LOW",
    },
    {
      id: "S5", intent: "Test the nginx config before starting", run: "sudo nginx -t",
      remote: true, sources: ["C5", "N5"], added: false, condition: null, on_fail: "abort_and_rollback", risk: "LOW",
    },
    {
      id: "S6", intent: "Start nginx again", run: "sudo systemctl start nginx",
      remote: true, sources: ["C6", "N6"], added: false, condition: null, on_fail: "abort_and_rollback", risk: "LOW",
    },
  ],
  rollback: [
    { run: "sayops_restore /etc/letsencrypt", remote: true, why: "N6" },
    { run: "sudo systemctl start nginx", remote: true, why: "N6" },
  ],
  verify: [
    {
      run: `curl -fsS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $AUTH_TOKEN" "https://$DOMAIN" | grep -qx 200`,
      remote: false, why: "N7",
    },
  ],
  findings: [
    {
      type: "said_not_done",
      detail: "You said “Before this I always back up the old cert folder” but no backup command ran. SayOps added it.",
      sources: ["N4"], fix_step: "S3",
    },
  ],
};
