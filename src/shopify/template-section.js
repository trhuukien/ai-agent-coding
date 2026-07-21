// Splices ONE section into a template JSON file (e.g. templates/index.json) without the caller
// ever needing to read or hold the rest of the file in its own context. This is what lets
// figma-page-agent.js run each page section as its own short-lived agent conversation — each section's
// agent only ever knows about its own section object, never the other 13 on the same page.
const fs = require('fs');
const path = require('path');
const { getThemeDir } = require('./cli');
const { sanitizeSection, extractSchema } = require('./validate-section');
const { auditSectionAgainstFigma, findBetterFileMatch, reportMissingFields, reportUnexportedIcons } = require('./audit-section');

const COMMENT_HEADER = /^\/\*[\s\S]*?\*\//;

function readTemplateData(filePath) {
  if (!fs.existsSync(filePath)) return { header: '', data: { sections: {}, order: [] } };
  const raw = fs.readFileSync(filePath, 'utf8');
  const commentMatch = raw.match(COMMENT_HEADER);
  const header = commentMatch ? `${commentMatch[0]}\n` : '';
  const jsonText = commentMatch ? raw.slice(commentMatch[0].length) : raw;
  const data = JSON.parse(jsonText);
  data.sections = data.sections || {};
  data.order = data.order || [];
  return { header, data };
}

// Returns the CURRENT object for one section (or null if the template/section doesn't exist yet)
// without the caller ever needing to read or hold the rest of the file — the read-side counterpart
// to upsertTemplateSection, for when you need to know what's already configured (e.g. refining an
// existing section's mobile settings) before merging in a change.
function readTemplateSection(store, themeId, templateKey, sectionKey) {
  const filePath = path.join(getThemeDir(store, themeId), templateKey);
  const { data } = readTemplateData(filePath);
  return data.sections[sectionKey] || null;
}

// Shallow-merges `patch` settings/blocks onto `existing`, key by key — a key present in `patch`
// overrides that same key in `existing`; every key NOT mentioned in `patch` is left untouched.
// Block settings merge the same way, one level down (per block key, then per setting id inside it).
function mergeSectionObjects(existing, patch) {
  if (!existing) return patch;
  const merged = { ...existing, ...patch };
  merged.settings = { ...(existing.settings || {}), ...(patch.settings || {}) };
  if (patch.blocks) {
    merged.blocks = { ...(existing.blocks || {}) };
    for (const [blockKey, block] of Object.entries(patch.blocks)) {
      const existingBlock = merged.blocks[blockKey];
      merged.blocks[blockKey] = existingBlock
        ? { ...existingBlock, ...block, settings: { ...(existingBlock.settings || {}), ...(block.settings || {}) } }
        : block;
    }
  } else if (existing.blocks) {
    merged.blocks = existing.blocks;
  }
  // block_order: only take the patch's order if the caller actually supplied one AND intends to
  // reorder/add blocks; otherwise keep the existing order untouched (a mobile-only refinement pass
  // should never silently reshuffle or drop blocks it didn't mean to touch).
  merged.block_order = patch.block_order && patch.block_order.length ? patch.block_order : existing.block_order;
  return merged;
}

function upsertTemplateSection(store, themeId, templateKey, sectionKey, rawSectionObject, positionAfter, merge = false, figmaNodes = null, svgExportCount = 0) {
  const filePath = path.join(getThemeDir(store, themeId), templateKey);
  const { header, data } = readTemplateData(filePath);

  const objectToValidate = merge ? mergeSectionObjects(data.sections[sectionKey], rawSectionObject) : rawSectionObject;

  // Hard gate: a section "type" with no matching real sections/<type>.liquid file is always an
  // invented/mistaken file choice (a real design never maps to a file that doesn't exist in this
  // theme) — reject outright instead of writing it "unvalidated", which would silently ship a
  // section Shopify can't actually render.
  const schema = extractSchema(store, themeId, objectToValidate.type);
  if (!schema) {
    throw new Error(
      `No sections/${objectToValidate.type}.liquid exists in this theme — refusing to write section "${sectionKey}" with an invented/nonexistent type. Pick a real file from list_theme_files.`
    );
  }

  // Auto-correct in code rather than rejecting and making the caller spend another turn fixing
  // it: out-of-range/off-step numbers get clamped+snapped, invalid "select" values fall back to
  // the field's own default, unknown/invented field ids get dropped. The write always proceeds;
  // `notes` just says what (if anything) was corrected, for the caller to report back.
  const { section: sectionObject, notes } = sanitizeSection(store, themeId, objectToValidate);

  // Deterministic cross-check against whatever Figma node(s) this same conversation already
  // fetched — catches the semantic gaps sanitizeSection can't see (schema-valid but missing bg
  // color / highlight brackets / enough repeated blocks). Same auto-correct policy as
  // sanitizeSection above: when there's exactly one color field and one matching Figma fill, it's
  // applied directly (not just reported) — only genuinely ambiguous cases (which of several
  // fields/fills pair up, how many blocks to duplicate, which field to bracket) fall back to a
  // "Flagged" note instead. See audit-section.js for the exact rules.
  if (figmaNodes && figmaNodes.length) {
    notes.push(...auditSectionAgainstFigma(figmaNodes, sectionObject, schema));
    for (const node of figmaNodes) {
      const fileNote = findBetterFileMatch(store, themeId, node?.name, sectionObject.type);
      if (fileNote) notes.push(fileNote);
    }
  }

  // Report-only (never auto-fills — see reportMissingFields' own docstring for why): every schema
  // field the model didn't explicitly write, flagged louder when its default is a non-blank
  // placeholder that would otherwise render as real, unintended content.
  notes.push(...reportMissingFields(sectionObject, schema));

  // Flags a built-in icon-select value with no matching real SVG export attempted this whole
  // conversation — catches the "guessed a built-in icon instead of fetching the real Figma vector"
  // failure mode the MAPPING_RULES icon rule warns against but can't itself enforce.
  notes.push(...reportUnexportedIcons(sectionObject, schema, svgExportCount));

  const existingIndex = data.order.indexOf(sectionKey);
  data.sections[sectionKey] = sectionObject;

  // Re-insert this key at its requested position, without disturbing any other key's position.
  // Updating an already-placed section with no explicit position_after keeps its current spot —
  // only a brand-new key with no position_after falls back to appending at the end.
  data.order = data.order.filter((key) => key !== sectionKey);
  if (positionAfter === 'start') {
    data.order.unshift(sectionKey);
  } else if (positionAfter && data.order.includes(positionAfter)) {
    data.order.splice(data.order.indexOf(positionAfter) + 1, 0, sectionKey);
  } else if (positionAfter == null && existingIndex !== -1) {
    data.order.splice(existingIndex, 0, sectionKey);
  } else {
    data.order.push(sectionKey);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${header}${JSON.stringify(data, null, 2)}\n`, 'utf8');

  return { sections: Object.keys(data.sections), order: data.order, notes };
}

module.exports = { upsertTemplateSection, readTemplateSection };
