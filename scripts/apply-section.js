#!/usr/bin/env node
// Helper for manually driving the same write path figma-page-agent.js's write_template_section
// tool uses (upsertTemplateSection -> sanitizeSection -> auditSectionAgainstFigma), so
// hand-authored section objects get the identical schema validation/auto-correction AND
// Figma cross-check the real agent tool would apply.
//
// The section JSON file must be the section object itself: { "type", "settings", "blocks",
// "block_order" } — NOT wrapped in { "section_key": ..., ... }.
//
// Usage:
//   node scripts/apply-section.js <store> <themeId> <template> <sectionKey> <sectionJsonFile> [positionAfter] [figmaDataFile] [merge]
//
//   figmaDataFile: optional path to a JSON file already fetched via figma-fetch-node.js /
//     figma-fetch-multi.js for THIS section — enables the auto-correct/flag cross-check
//     (background color, button style, heading highlights, carousel/rating indicators).
//     Pass "" (empty string) to skip it while still supplying positionAfter/merge.
//   merge: pass the literal string "merge" as the last arg to shallow-merge onto whatever
//     already exists at that section_key instead of a full replace.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { upsertTemplateSection } = require(path.join(__dirname, '..', 'src', 'shopify', 'template-section'));

const [, , store, themeId, template, sectionKey, jsonFile, positionAfter, figmaDataFile, mergeFlag] = process.argv;

if (!store || !themeId || !template || !sectionKey || !jsonFile) {
  console.error(
    'Usage: node scripts/apply-section.js <store> <themeId> <template> <sectionKey> <sectionJsonFile> [positionAfter] [figmaDataFile] [merge]'
  );
  process.exit(1);
}

const section = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));

let figmaNodes = [];
if (figmaDataFile) {
  const figmaRaw = JSON.parse(fs.readFileSync(figmaDataFile, 'utf8'));
  figmaNodes = Array.isArray(figmaRaw) ? figmaRaw : [figmaRaw];
}

const result = upsertTemplateSection(
  store,
  themeId,
  template,
  sectionKey,
  section,
  positionAfter || null,
  mergeFlag === 'merge',
  figmaNodes.filter(Boolean)
);
console.log(JSON.stringify(result, null, 2));
