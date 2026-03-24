#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /absolute/path/to/new-product"
  exit 1
fi

SRC_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
DEST_DIR="$1"

if [ -e "$DEST_DIR" ]; then
  echo "Destination already exists: $DEST_DIR"
  exit 1
fi

mkdir -p "$DEST_DIR"

rsync -a \
  --exclude '.git' \
  --exclude '.env' \
  --exclude '.DS_Store' \
  --exclude 'node_modules' \
  --exclude 'ai-server-live.js' \
  --exclude 'ai-server-live-original.js' \
  --exclude 'hello' \
  --exclude '*.zip' \
  --exclude 'server.log' \
  "$SRC_DIR"/ "$DEST_DIR"/

printf '\nCreated template copy at:\n%s\n' "$DEST_DIR"
printf '\nNext steps:\n'
printf '1. cd %s\n' "$DEST_DIR"
printf '2. Review NEW_PRODUCT_CHECKLIST.md\n'
printf '3. git init\n'
printf '4. create a new GitHub repo for this product\n'
