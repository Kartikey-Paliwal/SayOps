# SayOps SSL sandbox: a disposable web server for proof runs.
# Real nginx, openssl and curl; small stand-ins for certbot, systemctl and sudo (see bin/).
# Network is only needed to build this image. Proof runs start it with --network none.
FROM debian:bookworm-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nginx openssl curl ca-certificates procps \
 && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled/default
COPY bin/ /usr/local/bin/
COPY init.sh /usr/local/sbin/sayops-sandbox-init
RUN chmod 755 /usr/local/bin/* /usr/local/sbin/sayops-sandbox-init
LABEL sayops.sandbox="ssl"
CMD ["/usr/local/sbin/sayops-sandbox-init"]
