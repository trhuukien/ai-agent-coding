#!/usr/bin/env node
// Comprehensive read-only type audit across one or more templates/*.json files — cross-checks
// EVERY setting/block field's actual value against its real schema field type (array, boolean,
// number, valid select option, string), not just the 3 types sanitizeSection() auto-corrects at
// write time. Safe to run any time; makes no changes. Exit code 1 if any issue is found.
//
// Usage:
//   node scripts/validate-template-types.js <store> <themeId> [template ...]
//   With no template args, checks every templates/*.json file found for that theme.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { getThemeDir } = require('../src/shopify/cli');
const { extractSchema, collectFieldDefs } = require('../src/shopify/validate-section');

const [, , store, themeId, ...explicitTemplates] = process.argv;

if (!store || !themeId) {
  console.error('Usage: node scripts/validate-template-types.js <store> <themeId> [template ...]');
  process.exit(1);
}

const ARRAY_TYPES = new Set(['product_list', 'collection_list']);
const BOOL_TYPES = new Set(['checkbox']);
const STRING_TYPES = new Set([
  'text', 'richtext', 'html', 'url', 'color', 'font_picker', 'inline_richtext', 'textarea',
  'image_picker', 'video', 'video_url', 'product', 'collection', 'blog', 'page', 'article',
  'metaobject', 'link_list',
]);

function checkValue(def, value, where, issues) {
  const t = def.type;
  if (value === undefined) return;
  if (ARRAY_TYPES.has(t)) {
    if (!Array.isArray(value)) issues.push(`${where}: type "${t}" requires an array, got ${JSON.stringify(value)}`);
  } else if (BOOL_TYPES.has(t)) {
    if (typeof value !== 'boolean') issues.push(`${where}: type "${t}" requires a boolean, got ${JSON.stringify(value)}`);
  } else if (t === 'range' || t === 'number') {
    if (typeof value !== 'number') issues.push(`${where}: type "${t}" requires a number, got ${JSON.stringify(value)}`);
  } else if (t === 'select' || t === 'radio') {
    const allowed = (def.options || []).map((o) => (typeof o === 'string' ? o : o.value));
    if (allowed.length && !allowed.includes(value)) {
      issues.push(`${where}: type "${t}" value ${JSON.stringify(value)} not in allowed options [${allowed.join(', ')}]`);
    }
  } else if (STRING_TYPES.has(t)) {
    if (value !== null && typeof value !== 'string') issues.push(`${where}: type "${t}" requires a string (or null), got ${JSON.stringify(value)}`);
  }
}

function validateTemplate(templateKey) {
  const filePath = path.join(getThemeDir(store, themeId), templateKey);
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\/\*[\s\S]*?\*\//, '');
  const data = JSON.parse(raw);

  const issues = [];
  for (const [sectionKey, section] of Object.entries(data.sections || {})) {
    const schema = extractSchema(store, themeId, section.type);
    if (!schema) {
      issues.push(`${templateKey} > ${sectionKey}: no schema found for type "${section.type}"`);
      continue;
    }
    const { sectionFields, blockFields } = collectFieldDefs(schema, store, themeId);

    for (const [id, value] of Object.entries(section.settings || {})) {
      const def = sectionFields[id];
      if (!def) {
        issues.push(`${templateKey} > ${sectionKey}.settings.${id}: no matching field in schema (unknown/typo)`);
        continue;
      }
      checkValue(def, value, `${templateKey} > ${sectionKey}.settings.${id}`, issues);
    }

    for (const [blockKey, block] of Object.entries(section.blocks || {})) {
      const defs = blockFields[block.type];
      if (!defs) {
        issues.push(`${templateKey} > ${sectionKey}.blocks.${blockKey}: block type "${block.type}" not defined in schema`);
        continue;
      }
      for (const [id, value] of Object.entries(block.settings || {})) {
        const def = defs[id];
        if (!def) {
          issues.push(`${templateKey} > ${sectionKey}.blocks.${blockKey}.settings.${id}: no matching field in block "${block.type}" schema (unknown/typo)`);
          continue;
        }
        checkValue(def, value, `${templateKey} > ${sectionKey}.blocks.${blockKey}.settings.${id}`, issues);
      }
    }
  }
  return issues;
}

let templates = explicitTemplates;
if (!templates.length) {
  const templatesDir = path.join(getThemeDir(store, themeId), 'templates');
  templates = fs
    .readdirSync(templatesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => `templates/${f}`);
}

const allIssues = templates.flatMap(validateTemplate);

if (allIssues.length === 0) {
  console.log(`NO TYPE ISSUES FOUND across: ${templates.join(', ')}`);
} else {
  console.log(`FOUND ${allIssues.length} ISSUE(S):`);
  allIssues.forEach((i) => console.log(' - ' + i));
  process.exit(1);
}
