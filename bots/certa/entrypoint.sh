#!/bin/sh
# Starts the bot. With LITESTREAM_BUCKET set, first restores the database from the replica (when
# there is no local copy), then runs the bot under Litestream so every change is replicated.
set -e
if [ -z "$LITESTREAM_BUCKET" ]; then
  exec node dist/index.js
fi
mkdir -p "$(dirname "$CERTA_DB_PATH")"
litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$CERTA_DB_PATH"
exec litestream replicate -config /etc/litestream.yml -exec "node dist/index.js"
