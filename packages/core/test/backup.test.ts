import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHILD_HELPERS, normalizeBackups } from "../src";

// Disposable fixture only: every path lives under a fresh temp directory.
let root: string;
let target: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sayops backup '"));
  target = join(root, "letsencrypt");
  mkdirSync(join(target, "live", "shop"), { recursive: true });
  mkdirSync(join(target, "archive", "shop"), { recursive: true });
  writeFileSync(join(target, "archive", "shop", "cert1.pem"), "OLD CERT\n");
  writeFileSync(join(target, "renewal.conf"), "version=1\n");
  symlinkSync("../../archive/shop/cert1.pem", join(target, "live", "shop", "cert.pem"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Runs the same helpers the generated script ships, with sudo disabled. */
function helpers(body: string, runId = "t1") {
  const script = `set -euo pipefail\nSAYOPS_RUN_ID=${runId}\nSAYOPS_SUDO=none\n${CHILD_HELPERS}\n${body}\n`;
  return spawnSync("/bin/bash", ["-s"], { input: script, encoding: "utf8", env: { PATH: process.env.PATH ?? "", T: target } });
}

/** Path → file content or symlink target, for whole-tree comparison. */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const rel = `${prefix}${name}`;
    const st = lstatSync(p);
    if (st.isSymbolicLink()) out[rel] = `-> ${readlinkSync(p)}`;
    else if (st.isDirectory()) Object.assign(out, { [`${rel}/`]: "dir" }, snapshot(p, `${rel}/`));
    else out[rel] = readFileSync(p, "utf8");
  }
  return out;
}

/** What a botched renewal does: edits, adds and removes files, repoints the symlink. */
const BREAK = `printf 'version=2\\n' > "$T/renewal.conf"
printf 'NEW CERT\\n' > "$T/archive/shop/cert2.pem"
rm "$T/archive/shop/cert1.pem"
ln -sfn ../../archive/shop/cert2.pem "$T/live/shop/cert.pem"`;

describe("sayops_backup / sayops_restore", () => {
  it("restores the exact original tree, including symlinks and deleted files", () => {
    const before = snapshot(target);
    const r = helpers(`sayops_backup "$T"\n${BREAK}\nsayops_restore "$T"`);
    expect(r.status, r.stderr).toBe(0);
    expect(snapshot(target)).toEqual(before);
    // the restore replaced the tree; it did not copy the backup *into* it
    expect(existsSync(join(target, "letsencrypt.sayops-bak.t1"))).toBe(false);
    expect(existsSync(join(target, "archive", "shop", "cert2.pem"))).toBe(false);
  });

  it("keeps the failed state for inspection and leaves the backup intact", () => {
    const before = snapshot(target);
    helpers(`sayops_backup "$T"\n${BREAK}\nsayops_restore "$T"`);
    const failed = snapshot(`${target}.sayops-failed.t1`);
    expect(failed["renewal.conf"]).toBe("version=2\n");
    expect(failed["live/shop/cert.pem"]).toBe("-> ../../archive/shop/cert2.pem");
    expect(snapshot(`${target}.sayops-bak.t1`)).toEqual(before);
  });

  it("can be repeated without losing either failed state", () => {
    const r = helpers(`sayops_backup "$T"\n${BREAK}\nsayops_restore "$T"\nprintf 'version=3\\n' > "$T/renewal.conf"\nsayops_restore "$T"`);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(target, "renewal.conf"), "utf8")).toBe("version=1\n");
    expect(readFileSync(`${target}.sayops-failed.t1/renewal.conf`, "utf8")).toBe("version=2\n");
    expect(readFileSync(`${target}.sayops-failed.t1.1/renewal.conf`, "utf8")).toBe("version=3\n");
  });

  it("restores a missing target (the change deleted it)", () => {
    const r = helpers(`sayops_backup "$T"\nrm -rf "$T"\nsayops_restore "$T"`);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(target, "renewal.conf"), "utf8")).toBe("version=1\n");
  });

  it("refuses to restore without a backup and leaves the target untouched", () => {
    const before = snapshot(target);
    const r = helpers(`sayops_restore "$T"`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no backup");
    expect(snapshot(target)).toEqual(before);
  });

  it("refuses to overwrite an existing backup or back up a missing path", () => {
    expect(helpers(`sayops_backup "$T"\nsayops_backup "$T"`).stderr).toContain("already exists");
    const missing = helpers(`sayops_backup "$T/nope"`);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("does not exist");
  });

  it("works for a single file", () => {
    const r = helpers(`f="$T/renewal.conf"\nsayops_backup "$f"\nprintf 'x\\n' > "$f"\nsayops_restore "$f"`);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(target, "renewal.conf"), "utf8")).toBe("version=1\n");
  });
});

describe("normalizeBackups", () => {
  it.each([
    ['sudo cp -a /etc/letsencrypt "/etc/letsencrypt.bak.$SAYOPS_RUN_ID"', "sayops_backup /etc/letsencrypt"],
    ["sudo cp -a /etc/letsencrypt/live/$DOMAIN /etc/letsencrypt/live/$DOMAIN.bak.$SAYOPS_RUN_ID", 'sayops_backup "/etc/letsencrypt/live/$DOMAIN"'],
    ['sudo cp -a "/etc/letsencrypt.bak.$SAYOPS_RUN_ID/." /etc/letsencrypt/', "sayops_restore /etc/letsencrypt"],
    // what the live model wrote: the copy-into bug, chained with a restart
    [
      "sudo cp -r /etc/letsencrypt/live/$CERT_DOMAIN.bak_$SAYOPS_RUN_ID /etc/letsencrypt/live/$CERT_DOMAIN && sudo systemctl start nginx",
      'sayops_restore "/etc/letsencrypt/live/$CERT_DOMAIN" && sudo systemctl start nginx',
    ],
    ["sudo cp -a /etc/app /etc/app-backup", "sayops_backup /etc/app"],
    [
      "sudo cp -a /etc/letsencrypt.bak.$SAYOPS_RUN_ID /etc/letsencrypt && sudo systemctl start nginx",
      "sayops_restore /etc/letsencrypt && sudo systemctl start nginx",
    ],
    ["cp -a src.conf dst.conf", "cp -a src.conf dst.conf"],
    ["cp -a /etc/app.bak /etc/other", "cp -a /etc/app.bak /etc/other"],
  ])("%s", (input, expected) => {
    expect(normalizeBackups(input)).toBe(expected);
  });
});
