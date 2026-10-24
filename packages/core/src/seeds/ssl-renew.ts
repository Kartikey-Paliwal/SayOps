import type { SessionEvent, SessionMeta } from "../schemas";

/** Seed: renew an expiring SSL cert (judge-mode demo #1). Raw, before redaction. */
export const sslRenewMeta: SessionMeta = { title: "Renew SSL certificate", shell: "zsh", os: "darwin" };

export const sslRenewEvents: SessionEvent[] = [
  {"kind":"narration","seq":1,"t":"2026-10-24T10:02:05.000Z","text":"Renewing the SSL cert for a customer site. The server name and the domain change per customer."},
  {"kind":"command","seq":1,"t":"2026-10-24T10:02:11.120Z","cmd":"ssh web-1 'sudo certbot certificates -d shop.example.com'","exit":0,"ms":1450,"cwd":"/home/ops"},
  {"kind":"narration","seq":2,"t":"2026-10-24T10:02:20.502Z","text":"First check when it expires. Only renew if it's under 30 days, otherwise there's nothing to do."},
  {"kind":"command","seq":2,"t":"2026-10-24T10:02:41.008Z","cmd":"ssh web-1 'sudo sytemctl stop nginx'","exit":127,"ms":310,"cwd":"/home/ops"},
  {"kind":"command","seq":3,"t":"2026-10-24T10:02:47.300Z","cmd":"ssh web-1 'sudo systemctl stop nginx'","exit":0,"ms":890,"cwd":"/home/ops"},
  {"kind":"narration","seq":3,"t":"2026-10-24T10:02:55.410Z","text":"Stop nginx because certbot needs port 80 for the challenge."},
  {"kind":"command","seq":4,"t":"2026-10-24T10:03:12.000Z","cmd":"ssh web-1 'sudo certbot renew --cert-name shop.example.com'","exit":0,"ms":8200,"cwd":"/home/ops"},
  {"kind":"narration","seq":4,"t":"2026-10-24T10:03:24.700Z","text":"Renew it. Before this I always back up the old cert folder, just in case."},
  {"kind":"command","seq":5,"t":"2026-10-24T10:03:40.250Z","cmd":"ssh web-1 'sudo nginx -t'","exit":0,"ms":420,"cwd":"/home/ops"},
  {"kind":"narration","seq":5,"t":"2026-10-24T10:03:47.900Z","text":"Always test the config before starting, or the whole site goes down."},
  {"kind":"command","seq":6,"t":"2026-10-24T10:04:02.130Z","cmd":"ssh web-1 'sudo systemctl start nginx'","exit":0,"ms":760,"cwd":"/home/ops"},
  {"kind":"narration","seq":6,"t":"2026-10-24T10:04:09.440Z","text":"Start nginx again. If it doesn't come back, put the old cert back and start it."},
  {"kind":"command","seq":7,"t":"2026-10-24T10:04:25.010Z","cmd":"curl -sI -H 'Authorization: Bearer 9fQ2xLm7RtZ4vWbN8cKpYs3HdJ6gUe1A' https://shop.example.com","exit":0,"ms":540,"cwd":"/home/ops"},
  {"kind":"narration","seq":7,"t":"2026-10-24T10:04:31.600Z","text":"Confirm the site loads and returns 200."},
];
