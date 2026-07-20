#!/usr/bin/env node
// Batch-render one or more Figma nodes as real PNG screenshots (whole page frames, individual
// sections, or anything else) — a visual sanity-check that a JSON tree alone can't give: how many
// columns a row actually has, whether a pagination-dot strip means a real carousel, what's actually
// center- vs left-aligned. Complements figma-fetch-node.js/figma-fetch-multi.js, never replaces
// them — exact text/hex colors/settings still have to come from the JSON data, not pixels.
//
// Usage:
//   node scripts/figma-fetch-image.js <list-file> <out-dir> [scale]
//   list-file: plain text, one "key|figma-url" pair per line (same format as figma-fetch-multi.js;
//     a single-line file works fine for rendering just one node).
//   scale: optional Figma render scale (0.01-4, default 1). Use a smaller scale (e.g. 0.5) for a
//     very tall/large frame to keep the output at a legible-but-not-huge pixel size.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { fetchFigmaImages } = require('../src/figma/fetch-figma');

const listFile = process.argv[2];
const outDir = process.argv[3];
const scale = process.argv[4] ? parseFloat(process.argv[4]) : null;

if (!listFile || !outDir) {
  console.error('Usage: node scripts/figma-fetch-image.js <list-file> <out-dir> [scale]');
  process.exit(1);
}

(async () => {
  try {
    const lines = fs.readFileSync(listFile, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines.map((l) => {
      const [key, url] = l.split('|');
      return { key: key.trim(), url: url.trim() };
    });

    const urls = entries.map((e) => e.url);
    const buffers = await fetchFigmaImages(urls, process.env.FIGMA_ACCESS_TOKEN, scale);

    fs.mkdirSync(outDir, { recursive: true });
    entries.forEach((e, i) => {
      const buf = buffers[i];
      if (!buf) {
        console.log(`${e.key} -> NULL (Figma couldn't render this node — zero visible area?)`);
        return;
      }
      const outPath = path.join(outDir, `${e.key}.png`);
      fs.writeFileSync(outPath, buf);
      console.log(`${e.key} -> ${outPath} (${(buf.length / 1024).toFixed(0)} KB)`);
    });
  } catch (err) {
    console.error('ERROR:', err.message);
    if (err.response) console.error('status:', err.response.status, JSON.stringify(err.response.data));
    process.exit(1);
  }
})();
