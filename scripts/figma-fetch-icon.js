#!/usr/bin/env node
// Export ONE Figma node as real, normalized SVG markup (width/height rewritten to 100%,
// style="fill: none;" added so it inherits the theme's icon-color setting) — use this whenever a
// section/block schema has a "Custom icon (SVG code)" field and the design shows a specific icon.
// Never guess the closest-sounding built-in preset icon name when the real vector is one call away.
//
// Usage:
//   node scripts/figma-fetch-icon.js "<figma-url-with-node-id-of-the-icon-itself>" > icon.svg
require('dotenv').config({ quiet: true });
const { fetchFigmaIconSvg } = require('../src/figma/fetch-figma');

const url = process.argv[2];

if (!url) {
  console.error('Usage: node scripts/figma-fetch-icon.js "<figma-url>"');
  process.exit(1);
}

(async () => {
  try {
    const svg = await fetchFigmaIconSvg(url, process.env.FIGMA_ACCESS_TOKEN);
    console.log(svg);
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
})();
