#!/usr/bin/env node
// Fetch ONE Figma node's full design data (text, fills, box, fonts) as JSON.
// Does not need store/themeId — Figma access is store-independent (uses FIGMA_ACCESS_TOKEN only).
//
// Usage:
//   node scripts/figma-fetch-node.js "<figma-url-with-node-id>" [depth] > out.json
//   depth: optional integer. Omit for full depth (safe for a single section-sized frame).
//          Use a small number (2-8) for large/whole-file frames to keep the response readable.
require('dotenv').config({ quiet: true });
const { fetchFigmaNode } = require('../src/figma/fetch-figma');

const url = process.argv[2];
const depth = process.argv[3] ? parseInt(process.argv[3], 10) : null;

if (!url) {
  console.error('Usage: node scripts/figma-fetch-node.js "<figma-url>" [depth]');
  process.exit(1);
}

(async () => {
  try {
    const result = await fetchFigmaNode(url, process.env.FIGMA_ACCESS_TOKEN, depth);
    // Minified, not pretty-printed: this output is read by Claude (directly or via a file an
    // agent Reads), never scanned line-by-line by a human in a terminal — 2-space indentation on
    // a deeply-nested Figma tree adds pure whitespace with zero information value, measured at
    // ~63% of a real section's file size. JSON.parse gives back byte-identical data either way.
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error('ERROR:', err.message);
    if (err.response) console.error('status:', err.response.status, JSON.stringify(err.response.data));
    process.exit(1);
  }
})();
