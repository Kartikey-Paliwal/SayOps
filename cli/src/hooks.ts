/**
 * Opt-in shell integration. `sayops hook zsh` PRINTS code for the user to eval in one shell;
 * nothing is ever written to ~/.zshrc or any other file. `sayops unhook zsh` prints the undo.
 *
 * While a session is recording, each finished command is handed to `sayops _cmd` in a
 * detached background process (command text on stdin, never argv), so the prompt is never
 * delayed and a failure inside SayOps can never break the shell. When no session is
 * recording the hooks only test whether $SAYOPS_HOME/current exists.
 */

/** Single-quote for POSIX shells. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function hookScript(shell: "zsh" | "bash", invocation: string[], home: string): string {
  if (shell !== "zsh") throw new Error("bash capture is not supported yet; use zsh (the macOS default shell)");
  const bin = invocation.map(q).join(" ");
  const why = `why() {
  if [ ! -f "$_sayops_home/current" ]; then echo "sayops: no session is recording (run: sayops start \\"title\\")" >&2; return 1; fi
  local sid; sid=$(cat "$_sayops_home/current")
  if [ "$sid" != "$_sayops_sid" ]; then _sayops_sid=$sid; _sayops_seq=0; fi
  if [ "$#" -gt 0 ]; then
    _sayops_run why --session "$sid" --after "$_sayops_seq" "$@"
    return
  fi
  local text=""
  printf 'why> '
  IFS= read -r text || { echo; echo "sayops: cancelled, nothing recorded" >&2; return 130; }
  printf '%s' "$text" | _sayops_run why --session "$sid" --after "$_sayops_seq" --stdin
}`;
  const common = `_sayops_home=${q(home)}
_sayops_sid=""
_sayops_seq=0
_sayops_cmd=""
_sayops_run() { ${bin} "$@"; }
${why}`;

  if (shell === "zsh") {
    return `# SayOps shell integration (zsh), active in THIS shell only. Nothing was written to your config.
# Undo: eval "$(sayops unhook zsh)"   ·   Keep a command out of the recording: start it with a space.
zmodload zsh/datetime 2>/dev/null
${common}
_sayops_preexec() {
  _sayops_cmd=""
  [[ -f $_sayops_home/current ]] || return 0
  local c=\${1:-$3}
  case $c in
    " "*|why|"why "*|sayops|"sayops "*|*/sayops|*"/sayops "*|*sayops.mjs*|*"npx sayops"*|_sayops_*) return 0 ;;
  esac
  _sayops_cmd=$c
  _sayops_t0=$EPOCHREALTIME
}
_sayops_precmd() {
  local ec=$?
  [[ -n $_sayops_cmd ]] || return 0
  local c=$_sayops_cmd sid
  _sayops_cmd=""
  [[ -f $_sayops_home/current ]] || return 0
  sid=$(<$_sayops_home/current)
  [[ $sid == so_* ]] || return 0
  if [[ $sid != $_sayops_sid ]]; then _sayops_sid=$sid; _sayops_seq=0; fi
  (( _sayops_seq++ ))
  local ms=$(( (EPOCHREALTIME - _sayops_t0) * 1000 ))
  : >| "$_sayops_home/sessions/$sid/pending.$_sayops_seq" 2>/dev/null
  ( printf '%s' "$c" | _sayops_run _cmd --session "$sid" --seq "$_sayops_seq" --exit "$ec" --start "$_sayops_t0" --ms "\${ms%%.*}" --cwd "$PWD" >/dev/null 2>&1 & )
  return 0
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec _sayops_preexec
# first in line, so it sees the command's own exit code
precmd_functions=(_sayops_precmd \${precmd_functions:#_sayops_precmd})
echo "sayops: recording hooks are on in this shell. Undo with: eval \\"\\$(sayops unhook zsh)\\"" >&2
`;
  }

  throw new Error("bash capture is not supported yet; use zsh (the macOS default shell)");
}

export function unhookScript(): string {
  return `add-zsh-hook -d preexec _sayops_preexec 2>/dev/null
precmd_functions=(\${precmd_functions:#_sayops_precmd})
unfunction _sayops_preexec _sayops_precmd _sayops_run why 2>/dev/null
unset _sayops_home _sayops_sid _sayops_seq _sayops_cmd _sayops_t0
echo "sayops: recording hooks removed from this shell" >&2
`;
}
