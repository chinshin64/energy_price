#!/usr/bin/env bash
set -euo pipefail

TLS_ROOT="${TLS_ROOT:-/etc/data-for-didi-mobile-tls}"
PRIVATE_DIR="$TLS_ROOT/private"
CERT_DIR="$TLS_ROOT/certs"
CA_KEY="$PRIVATE_DIR/ca.key"
CA_CERT="$CERT_DIR/ca.crt"
SERVER_KEY="$PRIVATE_DIR/server.key"
SERVER_CERT="$CERT_DIR/server.crt"
SERVER_FULLCHAIN="$CERT_DIR/server-fullchain.pem"
SERVER_EXT="$TLS_ROOT/server.ext"
SERVER_IP="${SERVER_IP:-47.111.139.230}"
RENEW_BEFORE_SECONDS="${RENEW_BEFORE_SECONDS:-2592000}"
LEAF_VALID_DAYS="${LEAF_VALID_DAYS:-397}"
XP_NGINX="${XP_NGINX:-/xp/server/nginx/sbin/nginx}"
LOCK_FILE="$TLS_ROOT/renew.lock"

if [ "$(id -u)" -ne 0 ]; then
    echo "This renewal command must run as root." >&2
    exit 1
fi

for required_file in "$CA_KEY" "$CA_CERT" "$SERVER_EXT"; do
    if [ ! -s "$required_file" ]; then
        echo "Required TLS file is missing: $required_file" >&2
        exit 1
    fi
done

mkdir -p "$PRIVATE_DIR" "$CERT_DIR"
chmod 700 "$TLS_ROOT" "$PRIVATE_DIR"
chmod 755 "$CERT_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || {
    echo "Another TLS renewal is already running."
    exit 0
}

if [ "${FORCE_RENEW:-0}" != "1" ] \
    && [ -s "$SERVER_CERT" ] \
    && openssl x509 -checkend "$RENEW_BEFORE_SECONDS" -noout -in "$SERVER_CERT"; then
    echo "The current TLS leaf certificate remains valid for more than the renewal threshold."
    exit 0
fi

umask 077
TEMP_DIR="$(mktemp -d "$TLS_ROOT/renew.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

openssl genpkey \
    -algorithm EC \
    -pkeyopt ec_paramgen_curve:P-256 \
    -out "$TEMP_DIR/server.key"
openssl req \
    -new \
    -sha256 \
    -key "$TEMP_DIR/server.key" \
    -subj "/CN=$SERVER_IP/O=Data for Didi Mobile Source" \
    -out "$TEMP_DIR/server.csr"
openssl x509 \
    -req \
    -sha256 \
    -days "$LEAF_VALID_DAYS" \
    -in "$TEMP_DIR/server.csr" \
    -CA "$CA_CERT" \
    -CAkey "$CA_KEY" \
    -CAserial "$TLS_ROOT/ca.srl" \
    -CAcreateserial \
    -extfile "$SERVER_EXT" \
    -out "$TEMP_DIR/server.crt"

openssl verify -CAfile "$CA_CERT" "$TEMP_DIR/server.crt"
openssl x509 -in "$TEMP_DIR/server.crt" -noout -ext subjectAltName \
    | grep -Fq "IP Address:$SERVER_IP"
awk '1' "$TEMP_DIR/server.crt" "$CA_CERT" >"$TEMP_DIR/server-fullchain.pem"

install -o root -g root -m 600 "$TEMP_DIR/server.key" "$SERVER_KEY"
install -o root -g root -m 644 "$TEMP_DIR/server.crt" "$SERVER_CERT"
install -o root -g root -m 644 "$TEMP_DIR/server-fullchain.pem" "$SERVER_FULLCHAIN"

if [ -s /xp/panel/vhost/nginx/data-for-didi-mobile-source-https.conf ]; then
    "$XP_NGINX" -t
    "$XP_NGINX" -s reload
fi

openssl x509 -in "$SERVER_CERT" -noout -serial -dates
