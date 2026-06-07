#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p certs

if [[ ! -f certs/server.crt || ! -f certs/server.key ]]; then
  DNS_NAME="${DNS_NAME:-localhost}"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout certs/server.key \
    -out certs/server.crt \
    -days 1095 \
    -subj "/CN=${DNS_NAME}" \
    -addext "subjectAltName=DNS:${DNS_NAME},DNS:localhost"
fi

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3443}"
export HTTP_REDIRECT_PORT="${HTTP_REDIRECT_PORT:-3001}"
export HTTPS_KEY_FILE="${HTTPS_KEY_FILE:-certs/server.key}"
export HTTPS_CERT_FILE="${HTTPS_CERT_FILE:-certs/server.crt}"
export AUTH_COOKIE_SECURE="${AUTH_COOKIE_SECURE:-true}"

npm run build
npm run start:prod
