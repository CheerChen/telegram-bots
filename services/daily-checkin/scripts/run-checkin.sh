#!/bin/sh
set -eu

cd /app
exec ./node_modules/.bin/tsx src/index.ts
