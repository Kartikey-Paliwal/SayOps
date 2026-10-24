#!/usr/bin/env bash
# Sets up the throwaway environment for the real recorded task (NOT part of the recording).
# Everything lives in $TASK_DIR (default ~/sayops-real-task) and one local Caddy container
# bound to 127.0.0.1 only. Undo everything with teardown.sh.
set -euo pipefail
TASK_DIR=${TASK_DIR:-$HOME/sayops-real-task}
NAME=${CONTAINER:-sayops-devcert}
PORT=${PORT:-8443}
if [ -e "$TASK_DIR" ]; then echo "$TASK_DIR already exists; run teardown.sh first" >&2; exit 1; fi
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then echo "container $NAME already exists; run teardown.sh first" >&2; exit 1; fi
mkdir -p "$TASK_DIR/certs"
cd "$TASK_DIR"
# A dev certificate that expires in 5 days, so it is due for rotation.
openssl req -x509 -newkey rsa:2048 -nodes -days 5 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost" \
  -keyout certs/localhost.key -out certs/localhost.crt 2>/dev/null
chmod 644 certs/localhost.key   # readable by the container; this is a throwaway dev key
cat > Caddyfile <<CADDY
https://localhost:$PORT {
	tls /certs/localhost.crt /certs/localhost.key
	respond "sayops dev site ok" 200
}
CADDY
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:$PORT" \
  -v "$TASK_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$TASK_DIR/certs:/certs:ro" \
  --label sayops.realtask=1 caddy:2.10.2-alpine >/dev/null
for _ in $(seq 30); do curl -s --cacert certs/localhost.crt "https://localhost:$PORT" >/dev/null && break; sleep 0.5; done
echo "ready: https://localhost:$PORT serves a cert that expires $(openssl x509 -in certs/localhost.crt -noout -enddate | cut -d= -f2)"
