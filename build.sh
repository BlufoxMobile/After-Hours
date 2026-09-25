#!/bin/sh
# Build the single-file game: dist/index.html (everything inlined, zero network requests).
cd "$(dirname "$0")" && node tools/bundle.mjs src/main.js dist/index.html --shell shell.html --minify
