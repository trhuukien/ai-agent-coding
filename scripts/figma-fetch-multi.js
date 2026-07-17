#!/usr/bin/env node
// Batch-fetch several sibling Figma nodes from the SAME file in ONE API request (Figma's own
// recommended way to avoid rate limits — see fetch-figma.js's fetchFigmaNodes doc comment).
// Writes one JSON file per node into outDir, named "<key>.json".
//
// Usage:
//   node scripts/figma-fetch-multi.js <list-file> <out-dir> [depth]
//   list-file: plain text, one "key|figma-url" pair per line.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { fetchFigmaNodes } = require('../src/figma/fetch-figma');

const listFile = process.argv[2];
const outDir = process.argv[3];
const depth = process.argv[4] ? parseInt(process.argv[4], 10) : null;

if (!listFile || !outDir) {
  console.error('Usage: node scripts/figma-fetch-multi.js <list-file> <out-dir> [depth]');
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
    const results = await fetchFigmaNodes(urls, process.env.FIGMA_ACCESS_TOKEN, depth);

    fs.mkdirSync(outDir, { recursive: true });
    entries.forEach((e, i) => {
      const outPath = path.join(outDir, `${e.key}.json`);
      fs.writeFileSync(outPath, JSON.stringify(results[i], null, 2));
      console.log(`${e.key} -> ${outPath} (${results[i] ? 'ok' : 'NULL'})`);
    });
  } catch (err) {
    console.error('ERROR:', err.message);
    if (err.response) console.error('status:', err.response.status, JSON.stringify(err.response.data));
    process.exit(1);
  }
})();
