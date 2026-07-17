#!/usr/bin/env node
// Checks a font against Shopify's own real font_picker library (src/shopify/shopify-fonts.json,
// scraped from shopify.dev's fonts doc). Accepts EITHER input form:
//   - a bare family name as seen in a Figma Typography specimen (e.g. "Questrial")
//   - a full Shopify handle as actually stored in settings_data.json (e.g. "poppins_n4",
//     "playfair_display_i7") — the trailing `_[ni][1-9]` is parsed off and validated as a real
//     style/weight suffix, and the remaining family part is looked up the same way as a bare name.
// Use this BEFORE computing/writing any font_picker handle, so a typo or a genuinely-unavailable
// custom font gets caught here instead of silently producing a value nothing in Shopify recognizes.
//
// Usage:
//   node scripts/check-font-name.js "<family name OR full handle>"
//
// Exit code 0 + prints the exact matched name if found (case-insensitive exact match).
// Exit code 1 + prints the closest suggestions if not found exactly — review these by hand, this
// tool does not auto-pick a substitute for you.
const path = require('path');
const { families } = require(path.join(__dirname, '..', 'src', 'shopify', 'shopify-fonts.json'));

const rawQuery = process.argv[2];
if (!rawQuery) {
  console.error('Usage: node scripts/check-font-name.js "<family name OR full handle>"');
  process.exit(1);
}

// A real Shopify handle always ends in "_" + style ("n"/"i") + one digit 1-9 — strip that off (and
// convert the family part's underscores back to spaces) before doing the family lookup, so
// "poppins_n4" and "Poppins" both resolve to the exact same check.
const handleMatch = rawQuery.trim().match(/^(.+)_([ni])([1-9])$/i);
const isHandle = Boolean(handleMatch);
const query = isHandle ? handleMatch[1].replace(/_/g, ' ') : rawQuery;

const exact = families.find((f) => f.toLowerCase() === query.trim().toLowerCase());
if (exact) {
  const handleShown = isHandle ? rawQuery : `${exact.toLowerCase().replace(/ /g, '_')}_n4 (example — weight/style not specified in your query)`;
  console.log(`MATCH: "${exact}" is a real Shopify font_picker family.${isHandle ? ` Handle "${rawQuery}" parses as family="${exact}", style="${handleMatch[2].toLowerCase() === 'i' ? 'italic' : 'normal'}", weight digit=${handleMatch[3]}.` : ` (example handle: ${handleShown})`}`);
  process.exit(0);
}

// Simple Levenshtein distance for "did you mean" suggestions on a near-miss (typo) — not a
// semantic search, just edit-distance, which is exactly what a typo needs.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

const q = query.trim().toLowerCase();
const ranked = families
  .map((f) => ({ f, dist: levenshtein(q, f.toLowerCase()) }))
  .sort((a, b) => a.dist - b.dist)
  .slice(0, 5);

console.log(
  isHandle
    ? `NOT FOUND: handle "${rawQuery}" parses to family "${query}", which is not an exact match in Shopify's known font list.`
    : `NOT FOUND: "${query}" is not an exact match in Shopify's known font list.`
);
console.log('Closest suggestions (verify by hand before using any of these):');
ranked.forEach(({ f, dist }) => console.log(`  - "${f}" (edit distance ${dist})`));
console.log(
  '\nIf none of these are right, this may be a genuinely custom font not in Shopify\'s font_picker ' +
    'library at all — that requires uploading a font asset + custom @font-face CSS (a different ' +
    'workflow), not a font_picker value. Also note this local list can go stale; when in doubt, ' +
    'check the real Font Picker dropdown in the Shopify Theme Editor.'
);
process.exit(1);
