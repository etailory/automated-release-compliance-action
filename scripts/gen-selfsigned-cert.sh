#!/bin/sh
# gen-selfsigned-cert.sh — generate a self-signed TLS certificate for
# development and internal-use deployments of Governor OS.
#
# Output:
#   nginx/certs/fullchain.pem  — self-signed certificate
#   nginx/certs/privkey.pem    — private key (RSA 4096)
#
# Usage (from the repo root):
#   bash scripts/gen-selfsigned-cert.sh
#   # Optionally override the common name:
#   CERT_CN=compliance.internal bash scripts/gen-selfsigned-cert.sh
#
# For production, replace these files with a CA-signed certificate
# (e.g. from Let's Encrypt) before running docker compose up.

set -e

CERT_DIR="$(dirname "$0")/../nginx/certs"
CN="${CERT_CN:-localhost}"
DAYS="${CERT_DAYS:-825}"

mkdir -p "$CERT_DIR"

echo "Generating self-signed certificate for CN=$CN (valid $DAYS days)..."

openssl req -x509 \
  -newkey rsa:4096 \
  -sha256 \
  -days "$DAYS" \
  -nodes \
  -keyout "$CERT_DIR/privkey.pem" \
  -out    "$CERT_DIR/fullchain.pem" \
  -subj   "/CN=$CN" \
  -addext "subjectAltName=DNS:$CN,DNS:localhost,IP:127.0.0.1"

chmod 600 "$CERT_DIR/privkey.pem"
chmod 644 "$CERT_DIR/fullchain.pem"

echo "Done. Certificate written to:"
echo "  $CERT_DIR/fullchain.pem"
echo "  $CERT_DIR/privkey.pem"
echo ""
echo "Start the stack with: docker compose up -d"
echo "Verify: curl -k https://localhost/health"
