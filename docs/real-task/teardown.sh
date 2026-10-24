#!/usr/bin/env bash
# Removes everything prepare.sh created. Touches nothing else.
set -uo pipefail
TASK_DIR=${TASK_DIR:-$HOME/sayops-real-task}
NAME=${CONTAINER:-sayops-devcert}
docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed container $NAME" || echo "no container $NAME"
case "$TASK_DIR" in
  "$HOME"/sayops-real-task*|/private/tmp/*|/tmp/*|/var/folders/*) rm -rf "$TASK_DIR" && echo "removed $TASK_DIR" ;;
  *) echo "refusing to delete unexpected path $TASK_DIR" >&2; exit 1 ;;
esac
