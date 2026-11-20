#!/bin/sh
# Compile Shared/Models + Shared/Core with the Core tests and run them.
# ParityFixtures.swift (what the TypeScript returns for ~2,900 seeded inputs) is generated, not committed:
# it is rebuilt from packages/core and web/src/lib when missing (needs bun and the repo's node_modules).
set -e
cd "$(dirname "$0")/.."
TMPDIR="${TMPDIR:-/tmp}"
if [ ! -f CoreTests/ParityFixtures.swift ]; then
  bun CoreTests/gen-parity.ts .. CoreTests/ParityFixtures.swift
fi
swiftc -swift-version 5 -o "$TMPDIR/obelisk-coretests" Shared/Models/*.swift Shared/Core/*.swift CoreTests/*.swift && "$TMPDIR/obelisk-coretests"
