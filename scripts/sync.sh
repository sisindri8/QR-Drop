#!/usr/bin/env bash
# shared/session.js is the single source of truth; copy it to where it's used.
set -e
cd "$(dirname "$0")/.."
cp shared/session.js extension/lib/session.js
cp shared/session.js server/public/session.js
echo "synced shared/session.js -> extension/lib + server/public"
