// Sanitizes a section object against its own section file's real {% schema %} — instead of
// rejecting an out-of-range/invalid value and making the caller spend another API turn fixing it,
// this snaps it to the nearest valid value in code (clamp to min/max, round to the nearest valid
// step, fall back an invalid "select" value to the field's own default) and returns the corrected
// section alongside a plain-language note of what changed. An unknown/invented field id is dropped
// (there's no sensible value to snap it to) rather than blocking the write. Shopify enforces these
// same range/step/option rules on push — this just fixes the mismatch immediately instead of
// letting a bad value reach the file at all.
const fs = require('fs');
const path = require('path');
const { getThemeDir } = require('./cli');

// Setting types whose real Shopify value is an array of GIDs — only "product_list" and
// "collection_list" actually exist in this theme's schemas (verified by scanning every
// sections/*.liquid file's own "type" values); "link_list" LOOKS array-ish by name but is a
// single selected menu's handle (a string), not a list, so it's deliberately excluded here.
const ARRAY_TYPES = new Set(['product_list', 'collection_list']);
const BOOL_TYPES = new Set(['checkbox']);
// Every other value-holding type in this theme's schemas (text/richtext/html/url/color/
// font_picker/image_picker/video/product/collection/blog/page/article/metaobject/link_list/
// select/radio/textarea/inline_richtext/...) stores a plain string (or null when unset) —
// "select"/"radio" get their own option-membership check below, everything else just needs
// to not be an array/object/boolean/number that slipped in by mistake.

function extractSchema(store, themeId, sectionType, dir = 'sections') {
  const filePath = path.join(getThemeDir(store, themeId), dir, `${sectionType}.liquid`);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const start = raw.indexOf('{% schema %}');
  const end = raw.indexOf('{% endschema %}');
  if (start === -1 || end === -1) return null;
  const jsonText = raw.slice(start + '{% schema %}'.length, end);
  try {
    return JSON.parse(jsonText);
  } catch {
    // Some section files in this theme ship a trailing comma before a closing "}"/"]" (invalid
    // strict JSON, but a common hand-edit slip) — retry once with those stripped rather than
    // silently falling back to "unvalidated write" for the whole file.
    try {
      return JSON.parse(jsonText.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

// A section/block schema's own "blocks" array can declare "@theme" instead of listing real
// types — Shopify's own "theme blocks" feature, meaning "any block file from this theme's
// blocks/ directory is allowed here". The block's real "type" at write time is just that file's
// name (e.g. blocks/item-group.liquid -> type "item-group"), not the literal string "@theme" —
// so a template correctly using one of those real names must have its fields resolved from the
// referenced block file's own {% schema %}, or sanitizeSection would wrongly drop it as unknown.
function collectThemeBlockFields(store, themeId) {
  const blocksDir = path.join(getThemeDir(store, themeId), 'blocks');
  const fields = {};
  if (!fs.existsSync(blocksDir)) return fields;
  for (const file of fs.readdirSync(blocksDir)) {
    if (!file.endsWith('.liquid')) continue;
    const type = file.slice(0, -'.liquid'.length);
    const schema = extractSchema(store, themeId, type, 'blocks');
    if (!schema) continue;
    fields[type] = {};
    for (const s of schema.settings || []) if (s.id) fields[type][s.id] = s;
  }
  return fields;
}

function collectFieldDefs(schema, store, themeId) {
  const sectionFields = {};
  for (const s of schema.settings || []) if (s.id) sectionFields[s.id] = s;
  const blockFields = {};
  let themeBlockFields = null;
  for (const b of schema.blocks || []) {
    if (b.type === '@theme') {
      themeBlockFields = themeBlockFields || collectThemeBlockFields(store, themeId);
      Object.assign(blockFields, themeBlockFields);
      continue;
    }
    if (b.type === '@app') continue; // installed-app blocks have no local schema to resolve
    blockFields[b.type] = {};
    for (const s of b.settings || []) if (s.id) blockFields[b.type][s.id] = s;
  }
  return { sectionFields, blockFields };
}

// Returns { value, note } — note is null when the value needed no correction.
function snapValue(def, value, where) {
  if (def.type === 'range') {
    const { min, max, step } = def;
    let v = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(v)) {
      const fallback = def.default != null ? def.default : min;
      return { value: fallback, note: `${where}: "${value}" isn't a number — reset to ${fallback}` };
    }
    const original = v;
    v = Math.min(max, Math.max(min, v)); // clamp into [min, max]
    const steps = Math.round((v - min) / step);
    v = min + steps * step;
    // Floating point creep guard (e.g. 0.1 + 0.2 issues) — round to the same precision as step.
    const decimals = (String(step).split('.')[1] || '').length;
    v = Number(v.toFixed(decimals));
    if (v !== original) {
      return { value: v, note: `${where}: ${original} is not a valid step (min=${min}, step=${step}) — snapped to ${v}` };
    }
    return { value: v, note: null };
  }

  if (def.type === 'richtext' && typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return { value, note: null };
    // Shopify requires every top-level node in a "richtext" field to be a block tag
    // (<p>, <ul>, <ol>, or <h1>-<h6>) — bare text or inline-only markup (<strong>...</strong>,
    // plain "Some text") is rejected at push time with "All top level nodes must be...".
    // NOTE: this does NOT apply to schema type "html" — that field type is a free-form HTML/SVG
    // sink (e.g. custom icon markup) with no such AST restriction; wrapping an SVG in <p> would
    // itself become the bug. Only "richtext" enforces the paragraph/list/heading-root rule.
    // Auto-wrap instead of rejecting, per the same auto-snap policy as range/select.
    const startsWithBlockTag = /^<(p|ul|ol|h1|h2|h3|h4|h5|h6)[\s>]/i.test(trimmed);
    if (!startsWithBlockTag) {
      const wrapped = `<p>${trimmed}</p>`;
      return { value: wrapped, note: `${where}: richtext content had no top-level <p>/<ul>/<ol>/<h1-6> wrapper — wrapped in <p>...</p>` };
    }
    return { value, note: null };
  }

  if (def.type === 'select' && def.options) {
    const allowed = def.options.map((o) => o.value);
    if (allowed.includes(value)) return { value, note: null };
    const fallback = def.default != null && allowed.includes(def.default) ? def.default : allowed[0];
    return { value: fallback, note: `${where}: "${value}" is not a valid option [${allowed.join(', ')}] — fell back to "${fallback}"` };
  }

  if (ARRAY_TYPES.has(def.type)) {
    if (Array.isArray(value)) return { value, note: null };
    // No real product/collection GIDs can be guessed from a stray string/number here — the only
    // sensible auto-fix is "no references set yet", same as the field's own natural empty state.
    return { value: [], note: `${where}: type "${def.type}" requires an array, got ${JSON.stringify(value)} — reset to []` };
  }

  if (BOOL_TYPES.has(def.type)) {
    if (typeof value === 'boolean') return { value, note: null };
    if (value === 'true' || value === 'false') {
      const fixed = value === 'true';
      return { value: fixed, note: `${where}: type "checkbox" got the string "${value}" — converted to ${fixed}` };
    }
    const fallback = typeof def.default === 'boolean' ? def.default : false;
    return { value: fallback, note: `${where}: type "checkbox" requires a boolean, got ${JSON.stringify(value)} — reset to ${fallback}` };
  }

  // Every remaining value-holding type (text/richtext already handled above/html/url/color/
  // font_picker/image_picker/video/product/collection/blog/page/link_list/textarea/...) stores a
  // plain string or null — catch an array/object/boolean/number that slipped in by mistake instead
  // of letting it reach Shopify's own push-time validation as the first place it gets caught.
  if (value !== null && typeof value !== 'string' && typeof value !== 'undefined') {
    return { value: '', note: `${where}: type "${def.type}" requires a string (or null), got ${JSON.stringify(value)} — reset to ""` };
  }

  return { value, note: null };
}

// Returns { section: <corrected section object>, notes: [<what was auto-corrected or dropped>] }
function sanitizeSection(store, themeId, sectionObject) {
  const schema = extractSchema(store, themeId, sectionObject.type);
  const notes = [];

  if (!schema) {
    notes.push(`No sections/${sectionObject.type}.liquid schema found — wrote as-is, unvalidated.`);
    return { section: sectionObject, notes };
  }

  const { sectionFields, blockFields } = collectFieldDefs(schema, store, themeId);
  const section = { ...sectionObject, settings: {}, blocks: {} };

  for (const [id, value] of Object.entries(sectionObject.settings || {})) {
    const def = sectionFields[id];
    if (!def) {
      notes.push(`settings.${id}: no matching field in this section's schema — dropped (typo, or invented)`);
      continue;
    }
    const { value: fixed, note } = snapValue(def, value, `settings.${id}`);
    section.settings[id] = fixed;
    if (note) notes.push(note);
  }

  for (const [blockKey, block] of Object.entries(sectionObject.blocks || {})) {
    const defs = blockFields[block.type];
    if (!defs) {
      notes.push(`blocks.${blockKey}: "${block.type}" is not a block type this section's schema defines — dropped`);
      continue;
    }
    const fixedBlock = { ...block, settings: {} };
    for (const [id, value] of Object.entries(block.settings || {})) {
      const def = defs[id];
      if (!def) {
        notes.push(`blocks.${blockKey}.settings.${id}: no matching field in block type "${block.type}"'s schema — dropped`);
        continue;
      }
      const { value: fixed, note } = snapValue(def, value, `blocks.${blockKey}.settings.${id}`);
      fixedBlock.settings[id] = fixed;
      if (note) notes.push(note);
    }
    section.blocks[blockKey] = fixedBlock;
  }
  if (Object.keys(section.blocks).length === 0) delete section.blocks;

  return { section, notes };
}

module.exports = { sanitizeSection, extractSchema, collectFieldDefs };
