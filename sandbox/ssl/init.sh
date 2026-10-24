#!/bin/bash
# Prepares the sandbox: test CA (trusted inside the container only), a certificate that expires
# in SANDBOX_DAYS_LEFT days, and nginx serving SANDBOX_DOMAIN over HTTPS. Then waits.
set -euo pipefail
D=${SANDBOX_DOMAIN:-shop.example.com}
mkdir -p /etc/sayops-sandbox/ca /etc/letsencrypt/renewal
printf '%s' "$D" > /etc/sayops-sandbox/domain
printf '%s' "${SANDBOX_FAULT:-none}" > /etc/sayops-sandbox/fault
grep -q " $D\$" /etc/hosts || echo "127.0.0.1 $D" >> /etc/hosts
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 \
  -subj "/CN=SayOps Sandbox CA (test only)" \
  -keyout /etc/sayops-sandbox/ca/ca.key -out /etc/sayops-sandbox/ca/ca.pem 2>/dev/null
cp /etc/sayops-sandbox/ca/ca.pem /usr/local/share/ca-certificates/sayops-sandbox-ca.crt
update-ca-certificates >/dev/null 2>&1
sayops-sandbox-issue "$D" "${SANDBOX_DAYS_LEFT:-10}" 1
printf 'version = sandbox\narchive_dir = /etc/letsencrypt/archive/%s\n' "$D" > "/etc/letsencrypt/renewal/$D.conf"
cat > /etc/nginx/conf.d/site.conf <<NGINX
server {
  listen 80;
  server_name $D;
  location / { return 200 "http ok\n"; }
}
server {
  listen 443 ssl;
  server_name $D;
  ssl_certificate /etc/letsencrypt/live/$D/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$D/privkey.pem;
  location / {
    if (\$http_authorization = "") { return 401 "missing token\n"; }
    return 200 "ok\n";
  }
}
NGINX
nginx
touch /run/sayops-sandbox-ready
exec sleep infinity
