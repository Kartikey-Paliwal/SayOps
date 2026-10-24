import { describe, expect, it } from "vitest";
import { parseJsonl, redactEvents, redactText, sslRenewEvents } from "../src";

describe("redactText", () => {
  const cases: [string, string, string][] = [
    ["github", "git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789AB@github.com/x/y", "github_token"],
    ["aws", "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "aws_key"],
    ["conn string", "psql postgres://admin:hunter2pass@db.internal:5432/app", "conn_password"],
    ["--password", "mysql -u root --password=s3cr3tPass", "password"],
    ["env", "DB_PASSWORD='p@ss w' ./run", "env_secret"],
    ["bearer", "curl -H 'Authorization: Bearer 9fQ2xLm7RtZ4vWbN8cKpYs3HdJ6gUe1A' x", "bearer"],
    ["jwt", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt"],
    ["anthropic", "ANTHROPIC=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA", "anthropic_key"],
  ];
  it.each(cases)("masks %s", (_name, input, type) => {
    const r = redactText(input);
    expect(r.found).toContain(type);
    expect(r.text).toContain(`<REDACTED:${type}>`);
  });

  it("keeps ordinary commands and shell variables untouched", () => {
    for (const s of [
      "ssh web-1 'sudo systemctl restart nginx'",
      "psql postgres://app@db.internal/app",
      "mysql --password=$DB_PASS",
      "git checkout 3f2a9c1b7e5d4a6f8b0c2e1d3f5a7b9c0d2e4f6a",
      "Don't restart it if it's busy",
      "/var/folders/9d/wvb99nld7ss1n9vtx8ypf3p00000gn/T/tmp.UiPsqqeftb/demo",
      "cd /Users/kartikeypaliwal/Library/Application Support/Code/User/workspaceStorage/3f2a9c1b7e5d",
      "docker run --rm -v /private/var/folders/9d/wvb99nld7ss1n9vtx8ypf3p00000gn/T/x:/data alpine ls /data",
    ]) {
      expect(redactText(s)).toEqual({ text: s, found: [] });
    }
  });
});

it("still catches a high-entropy token inside a path or URL", () => {
  const r = redactText("curl https://hooks.example.com/services/T00000000/Zk8xQ2mR9vLp4Nw7Yc3Hb6Dt1Fg5Js0A");
  expect(r.found).toContain("high_entropy");
  expect(r.text).toContain("/services/T00000000/<REDACTED:high_entropy>");
});

describe("redactEvents", () => {
  it("masks the bearer token in the SSL fixture before upload", () => {
    const { events, count } = redactEvents(sslRenewEvents);
    expect(count).toBe(1);
    expect(JSON.stringify(events)).not.toContain("9fQ2xLm7");
  });
});

describe("parseJsonl", () => {
  it("round-trips a recorded session file", () => {
    const src = sslRenewEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
    expect(parseJsonl(src)).toEqual(sslRenewEvents);
  });
});
