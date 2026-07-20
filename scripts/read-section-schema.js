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

// Every icon-picker `select` field in this theme carries the SAME ~80-value preset icon list
// (leaf/truck/award/star/.../yoga, plus "none" and "another_icon") — verbatim, every single time,
// across every section/block that has one. Measured on a real build: this one repeated list alone
// was 26% of main-product's entire phase-2 payload (21 icon fields x the same ~80-line array).
// Per this project's own rule (§5), a real custom_icon SVG always takes rendering priority over
// whichever preset is picked anyway — the only reason the select field's own value ever matters is
// that it must be non-"none" for the paired custom_icon field to even become visible/render at all.
// So: never spend tokens re-reading this same static list per field — collapse it to a short note
// instead, still keeping id/type/label/default (all field-specific, still needed) intact.
function compressIconPickers(settingsArray) {
  return (settingsArray || []).map((s) => {
    const isIconPicker =
      s.type === 'select' && Array.isArray(s.options) && s.options.length > 30 &&
      s.options.some((o) => o && o.value === 'another_icon');
    if (!isIconPicker) return s;
    const { options, ...rest } = s;
    return {
      ...rest,
      iconPickerNote:
        'Standard ~80-option Shopify icon picker (options list omitted here — identical across ' +
        'every icon field in this theme). When a real Figma vector exists for this icon (the ' +
        'normal case — never guess a preset when a real vector is exportable), set this field to ' +
        '"another_icon" and put the exported SVG in the paired custom_icon field; a set custom_icon ' +
        'always overrides this preset at render time, so its exact value barely matters as long as ' +
        'it is not "none". Only pick a real preset name (e.g. truck, gift, heart, star, leaf, award, ' +
        'shopping-bag, check-mark) if genuinely no Figma vector exists for this icon.',
    };
  });
}

// A settings entry with no `id` (a bare `{"type": "header", "content": "..."}` divider or a
// `{"type": "paragraph", "content": "Learn how to use this section: <link>"}` help blurb) is pure
// Theme-Editor-UI organization for the merchant — it is never itself a writable field, so it never
// needs to reach the model that's deciding what values to write.
function dropDocOnlyEntries(settingsArray) {
  return (settingsArray || []).filter((s) => s.id);
}

function slimSettings(settingsArray) {
  return compressIconPickers(dropDocOnlyEntries(settingsArray));
}

if (blockTypes.length === 0) {
  // Phase 1: index only — every block type's own settings array replaced with just its length,
  // so you can see WHAT exists and decide what you need without paying for the full field list.
  const index = {
    name: resolved.name,
    settings: slimSettings(resolved.settings),
    blockTypes: (resolved.blocks || []).map((b) => ({
      type: b.type,
      name: b.name,
      settingsCount: (b.settings || []).length,
    })),
  };
  // Minified — read by an agent, not scanned by a human; indentation is pure whitespace overhead.
  console.log(JSON.stringify(index));
} else {
  // Phase 2: full field definitions, but ONLY for the requested block types.
  const wanted = new Set(blockTypes);
  const matched = (resolved.blocks || [])
    .filter((b) => wanted.has(b.type))
    .map((b) => ({ ...b, settings: slimSettings(b.settings) }));
  const missing = blockTypes.filter((t) => !matched.some((b) => b.type === t));
  if (missing.length) {
    console.error(`Warning: these block types don't exist in this schema: ${missing.join(', ')}`);
  }
  console.log(JSON.stringify({ name: resolved.name, settings: slimSettings(resolved.settings), blocks: matched }));
}
