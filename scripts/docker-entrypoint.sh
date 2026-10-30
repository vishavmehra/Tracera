#!/bin/sh
# A persistent disk is mounted owned by root, so the unprivileged app user cannot write to it. Start
# as root only long enough to hand the data directory to that user, then drop privileges for good.
set -eu

if [ "$(id -u)" = 0 ]; then
	if [ -n "${TRACERA_DATA_DIR:-}" ]; then
		mkdir -p "$TRACERA_DATA_DIR"
		chown node:node "$TRACERA_DATA_DIR"
	fi
	export HOME=/home/node
	exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
