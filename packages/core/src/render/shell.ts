/** Small, dependency-free helpers shared by the renderers. */

/** POSIX single-quote a string: the result is always one literal shell word. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** One-line, comment-safe text (no newlines, bounded length). */
export function oneLine(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "sayops-task";
}

/** Names from `names` that `cmd` references as $NAME or ${NAME…}. */
export function referencedVars(cmd: string, names: string[]): string[] {
  return names.filter((n) => new RegExp(`\\$(?:\\{${n}\\b|${n}(?![A-Za-z0-9_]))`).test(cmd));
}

/** Secret params come from redacted values and are only ever read from the environment. */
export function isSecretParam(from: string): boolean {
  return /^<REDACTED:[a-z_]+>$/.test(from);
}

/**
 * Bash run inside every step's child shell (locally or on the remote host).
 * SAYOPS_SUDO: "auto" (default: sudo when not root), "none", or a command such as "sudo -n".
 * `sayops_backup`/`sayops_restore` give rollback real restore semantics:
 *   - backup refuses to overwrite an existing backup or to back up a missing path;
 *   - restore never copies *into* the current tree: it moves the current (failed)
 *     state aside to <path>.sayops-failed.<run>[.n] — never deleting it — then copies
 *     the backup back to <path>. The backup itself stays intact, so restore can be retried.
 */
export const CHILD_HELPERS = `case "\${SAYOPS_SUDO:-auto}" in
  auto) if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SAYOPS_SUDO=sudo; else SAYOPS_SUDO=; fi ;;
  none) SAYOPS_SUDO= ;;
esac
sayops_backup() {
  local p="\${1:?sayops_backup needs a path}" b
  b="$p.sayops-bak.$SAYOPS_RUN_ID"
  if ! $SAYOPS_SUDO test -e "$p"; then echo "sayops_backup: $p does not exist" >&2; return 1; fi
  if $SAYOPS_SUDO test -e "$b"; then echo "sayops_backup: $b already exists; refusing to overwrite it" >&2; return 1; fi
  $SAYOPS_SUDO cp -a -- "$p" "$b"
  echo "sayops: backed up $p -> $b"
}
sayops_restore() {
  local p="\${1:?sayops_restore needs a path}" b f n=0
  b="$p.sayops-bak.$SAYOPS_RUN_ID"
  if ! $SAYOPS_SUDO test -e "$b"; then echo "sayops_restore: no backup at $b; nothing restored" >&2; return 1; fi
  if $SAYOPS_SUDO test -e "$p" || $SAYOPS_SUDO test -L "$p"; then
    f="$p.sayops-failed.$SAYOPS_RUN_ID"
    while $SAYOPS_SUDO test -e "$f"; do n=$((n + 1)); f="$p.sayops-failed.$SAYOPS_RUN_ID.$n"; done
    $SAYOPS_SUDO mv -- "$p" "$f"
    echo "sayops: kept the failed state at $f"
  fi
  $SAYOPS_SUDO cp -a -- "$b" "$p"
  echo "sayops: restored $p from $b"
}`;
