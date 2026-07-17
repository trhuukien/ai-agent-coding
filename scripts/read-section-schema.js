#!/usr/bin/env node
// Reads ONLY a section's {% schema %} JSON (not the whole .liquid file's markup/render logic),
// with every "t:..." translation key already resolved to real English text.
//
// Two-phase use, so a huge multi-block-type file (e.g. main-product.liquid has ~35 block types)
// never has to be read in full just to configure the handful a design actually shows:
//
//   Phase 1 — INDEX (cheap): no block-type args → returns section-level settings PLUS just the
//   list of available block types (type + admin name), never their full field lists. Compare this
//   against what the Figma design actually shows and decide which block types you need.
//
//   Phase 2 — DETAIL (targeted): pass the block type(s) you decided you need → returns
//   section-level settings PLUS the FULL field definitions for ONLY those block types.
//
// Usage:
//   node scripts/read-section-schema.js <store> <themeId> <sectionType> [blockType ...]
//   e.g. node scripts/read-section-schema.js kizchann.myshopify.com 189953245548 main-product
//        node scripts/read-section-schema.js kizchann.myshopify.com 189953245548 main-product price buy_buttons rating
require('dotenv').config({ quiet: true });
const { extractSchema } = require('../src/shopify/validate-section');
const { resolveSchemaTranslations } = require('../src/shopify/locale-resolve');

const [, , store, themeId, sectionType, ...blockTypes] = process.argv;

if (!store || !themeId || !sectionType) {
  console.error('Usage: node scripts/read-section-schema.js <store> <themeId> <sectionType> [blockType ...]');
  process.exit(1);
}

const schema = extractSchema(store, themeId, sectionType);
if (!schema) {
  console.error(`No sections/${sectionType}.liquid schema found.`);
  process.exit(1);
}

// Resolve every "t:..." key by round-tripping through the same regex-based resolver
// read_theme_file uses on raw file text — reuse it as-is rather than duplicating the lookup.
const resolved = JSON.parse(resolveSchemaTranslations(JSON.stringify(schema), store, themeId));

if (blockTypes.length === 0) {
  // Phase 1: index only — every block type's own settings array replaced with just its length,
  // so you can see WHAT exists and decide what you need without paying for the full field list.
  const index = {
    name: resolved.name,
    settings: resolved.settings || [],
    blockTypes: (resolved.blocks || []).map((b) => ({
      type: b.type,
      name: b.name,
      settingsCount: (b.settings || []).length,
    })),
  };
  console.log(JSON.stringify(index, null, 2));
} else {
  // Phase 2: full field definitions, but ONLY for the requested block types.
  const wanted = new Set(blockTypes);
  const matched = (resolved.blocks || []).filter((b) => wanted.has(b.type));
  const missing = blockTypes.filter((t) => !matched.some((b) => b.type === t));
  if (missing.length) {
    console.error(`Warning: these block types don't exist in this schema: ${missing.join(', ')}`);
  }
  console.log(JSON.stringify({ name: resolved.name, settings: resolved.settings || [], blocks: matched }, null, 2));
}
