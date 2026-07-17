#!/usr/bin/env node
// Read one local theme file, with every "t:..." translation key already resolved to real English
// text (for .liquid section files and config/settings_schema.json) — same as workflow-e's own
// read_theme_file tool. Never guess what a "t:..." key means; this resolves it for real.
//
// Usage:
//   node scripts/read-theme-file.js <store> <themeId> <file-key>
//   e.g. node scripts/read-theme-file.js kizchann.myshopify.com 189953245548 sections/multicolumn.liquid
require('dotenv').config({ quiet: true });
const { readLocalFile } = require('../src/shopify/cli');
const { resolveSchemaTranslations } = require('../src/shopify/locale-resolve');

const [, , store, themeId, key] = process.argv;

if (!store || !themeId || !key) {
  console.error('Usage: node scripts/read-theme-file.js <store> <themeId> <file-key>');
  process.exit(1);
}

const content = readLocalFile(store, themeId, key);
if (content === null) {
  console.error('File not found:', key);
  process.exit(1);
}
const needsResolve = key.endsWith('.liquid') || key === 'config/settings_schema.json';
console.log(needsResolve ? resolveSchemaTranslations(content, store, themeId) : content);
