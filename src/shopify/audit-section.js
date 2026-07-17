// Deterministic, code-only cross-check of a just-written section against the Figma node(s)
// already fetched earlier in the SAME agent conversation — no extra LLM call, no reliance on the
// model remembering a prompt rule. sanitizeSection() (validate-section.js) only checks a section
// against its OWN schema (range/step/select/richtext-shape); it has no idea what the design actually
// looked like. This module catches the category of bug that kept recurring across two separate
// theme audits despite being documented in prompts: a solid background fill on the Figma frame with
// no matching color field set, a mixedStyleRuns "highlight" not wrapped in [brackets], and a Figma
// pagination counter ("1/5") implying more repeated blocks than were actually written. None of these
// require judgment about DESIGN INTENT — they're structural mismatches between two JSON blobs.
const fs = require('fs');
const path = require('path');

function normalizeColor(c) {
  if (c == null) return null;
  const s = String(c).trim().toLowerCase();
  if (s === '' || s === 'rgba(0,0,0,0)' || s === 'transparent') return null;
  return s;
}

// Euclidean distance in RGB space between two #rrggbb(aa) strings; null if either isn't parseable.
function hexDistance(a, b) {
  const parse = (s) => {
    const m = /^#([0-9a-f]{6})/i.exec(s);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  return Math.sqrt(pa.reduce((sum, v, i) => sum + (v - pb[i]) ** 2, 0));
}

function findOwnSolidFill(node) {
  if (node.fills && node.fills.length === 1 && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(node.fills[0])) {
    return node.fills[0].slice(0, 7);
  }
  return null;
}

// The frame that carries a section's background color is often a sub-frame one or two levels
// in (e.g. a text panel inside a hero, a tinted strip behind a heading) — not necessarily the
// exact node the caller fetched. Collect every distinct solid fill anywhere in the subtree, each
// tagged with the node/box it came from, rather than only checking the root. Small nodes (icons,
// buttons, badges) are excluded by the caller via a minimum area-share check — a button having its
// own solid fill is normal and isn't evidence of a missing SECTION background.
function collectSolidFills(node, acc = []) {
  const fill = findOwnSolidFill(node);
  if (fill) acc.push({ name: node.name, id: node.id, fill, box: node.box || null });
  if (node.children) node.children.forEach((c) => collectSolidFills(c, acc));
  return acc;
}

// Buttons are small, so they'd never pass the background check's area-share filter — collect them
// separately, by name, regardless of size.
function collectButtonFills(node, acc = []) {
  const fill = findOwnSolidFill(node);
  if (fill && /button|\bcta\b/i.test(node.name || '')) acc.push({ name: node.name, id: node.id, fill });
  if (node.children) node.children.forEach((c) => collectButtonFills(c, acc));
  return acc;
}

// A "highlighted" run is one that differs from the node's own BASE style in a way that's visually
// a highlight — Figma's characterStyleOverrides frequently re-states the SAME color, or an
// unrelated font-family override, across the entire string (e.g. a whole heading rendered in a
// display serif while the node's own reported base font is a different family) without that being
// a highlight at all. Only color (meaningfully different from the base) or italic reliably signal
// an intentional highlight in this theme's designs; a bare font-family difference is too noisy to
// use as a standalone trigger since it's frequently uniform across the ENTIRE string.
function collectHighlightedRunTexts(node, acc = []) {
  if (node.mixedStyleRuns) {
    const baseColor = node.color && node.color[0];
    for (const run of node.mixedStyleRuns) {
      const colorDiffers = run.color && (!baseColor || (hexDistance(run.color[0], baseColor) ?? 999) > 20);
      if (colorDiffers || run.italic) {
        const text = (run.text || '').trim();
        if (text) acc.push(text);
      }
    }
  }
  if (node.children) node.children.forEach((c) => collectHighlightedRunTexts(c, acc));
  return acc;
}

function collectPaginationCounters(node, acc = []) {
  if (node.characters) {
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(node.characters.trim());
    if (m) acc.push({ raw: node.characters.trim(), current: Number(m[1]), total: Number(m[2]) });
  }
  if (node.children) node.children.forEach((c) => collectPaginationCounters(c, acc));
  return acc;
}

// Button style (primary/secondary/text-link) read straight from the node's own paint data — a
// solid fill of its own means a filled ("primary") button, a stroke with no fill means an outline
// ("secondary") button, neither means it's just styled text ("text-link"). Mirrors the prompt rule
// of the same name, but as a direct fact-check instead of something the model has to remember to do.
function detectButtonStyle(node) {
  if (findOwnSolidFill(node)) return 'primary';
  if (node.strokes && node.strokes.length) return 'secondary';
  return 'text-link';
}

function collectButtonStyleNodes(node, acc = []) {
  if (/button|\bcta\b/i.test(node.name || '') && (node.fills || node.strokes)) {
    acc.push({ name: node.name, id: node.id, style: detectButtonStyle(node) });
  }
  if (node.children) node.children.forEach((c) => collectButtonStyleNodes(c, acc));
  return acc;
}

// Returns field-DEFINITION objects (not just ids) so callers can check visible_if per block
// instance before applying.
function buttonStyleFieldsByBlock(schema) {
  const map = {};
  for (const b of schema.blocks || []) {
    map[b.type] = (b.settings || []).filter(
      (s) =>
        s.type === 'select' &&
        s.id &&
        /button_style/i.test(s.id) &&
        (s.options || []).some((o) => (typeof o === 'string' ? o : o.value) === 'primary')
    );
  }
  return map;
}

// A "Scroll Bar"/"Carousel" decorative instance under a row of repeated items means that row is a
// swipeable mobile carousel in the design — not a static wrapped grid.
function collectCarouselIndicators(node, acc = []) {
  if (/scroll ?bar|carousel/i.test(node.name || '')) acc.push(node.name);
  if (node.children) node.children.forEach((c) => collectCarouselIndicators(c, acc));
  return acc;
}

// A "Rating Star" instance (the icon row itself, usually decorative/pruned) means the design shows
// a real star rating on that card/testimonial.
function collectRatingIndicators(node, acc = []) {
  if (/rating ?star/i.test(node.name || '')) acc.push(node.name);
  if (node.children) node.children.forEach((c) => collectRatingIndicators(c, acc));
  return acc;
}

function deepStringValues(obj, acc = []) {
  if (typeof obj === 'string') {
    acc.push(obj);
  } else if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) deepStringValues(v, acc);
  }
  return acc;
}

// Finds every string field anywhere in `obj` whose value contains `text`, each tagged with the
// exact path needed to mutate it back (setByPath). Used to auto-wrap a highlighted run in
// [brackets] only when there's exactly one field it could possibly belong to.
function findFieldsContaining(obj, text, path = [], acc = []) {
  if (typeof obj === 'string') {
    if (obj.includes(text)) acc.push({ path, value: obj });
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) findFieldsContaining(v, text, [...path, k], acc);
  }
  return acc;
}

function setByPath(root, path, value) {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
  cur[path[path.length - 1]] = value;
}

function getByPath(root, path) {
  let cur = root;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

// Given the path to a field that just got a [bracket] highlight inserted, finds whether the SAME
// settings object (section-level, or that specific block's settings) also declares a
// "highlight_type" field in its own real schema — only then is it safe to set one, otherwise we'd
// be inventing a field sanitizeSection would have to drop. path looks like
// ['settings', 'heading'] (section-level) or ['blocks', 'col_1', 'settings', 'title'] (block-level).
function highlightTypeFieldPath(schema, sectionObject, path) {
  if (path[0] === 'settings') {
    return (schema.settings || []).some((s) => s.id === 'highlight_type') ? ['settings', 'highlight_type'] : null;
  }
  if (path[0] === 'blocks') {
    const blockKey = path[1];
    const blockType = sectionObject.blocks?.[blockKey]?.type;
    const block = (schema.blocks || []).find((b) => b.type === blockType);
    const has = block ? (block.settings || []).some((s) => s.id === 'highlight_type') : false;
    return has ? ['blocks', blockKey, 'settings', 'highlight_type'] : null;
  }
  return null;
}

// A schema field can be gated behind another setting via `visible_if` (e.g. a button's color field
// only matters when that block's own "enable_promotion_highlight" checkbox is on) — Shopify's admin
// UI hides it, and this theme's own liquid rendering commonly checks the same flag before using the
// field at all. Auto-applying a value into a currently-inactive field is worse than a no-op: it's
// very likely the WRONG field for whatever Figma element triggered the match (a real button visible
// in the design usually belongs to a DIFFERENT, currently-active part of the section, not a hidden
// opt-in extra), so treat any field whose visible_if isn't satisfied as not a candidate at all.
function isFieldActive(fieldDef, ownerSettings) {
  if (!fieldDef.visible_if) return true;
  const m = /\{\{\s*(?:block|section)\.settings\.(\w+)\s*(!?=)?\s*'?([\w-]*)'?\s*\}\}/.exec(fieldDef.visible_if);
  if (!m) return true; // can't confidently parse a complex expression — don't block on uncertainty
  const [, refId, op, refCompareValue] = m;
  const actual = ownerSettings?.[refId];
  if (!op) return Boolean(actual); // bare "{{ block.settings.x }}" — truthy check
  return op === '!=' ? String(actual) !== refCompareValue : String(actual) === refCompareValue;
}

function collectColorFieldIds(schema) {
  const ids = [];
  for (const s of schema.settings || []) {
    if (s.type === 'color' && s.id && !/_dark$/.test(s.id)) ids.push(s.id);
  }
  return ids;
}

// A block typically has SEVERAL button-related color fields (background, text, hover, secondary) —
// only the button's own BACKGROUND fill is comparable to a Figma button's solid fill, so this picks
// that one specifically instead of the broad /button/i match, which would otherwise make almost
// every block "ambiguous" (multiple candidate fields) and never auto-apply anything.
const PRIMARY_BUTTON_BG_PATTERN = /^(color_button|button_light|background_button)$/;
// Returns full field-DEFINITION objects (not just ids) so callers can check visible_if per block
// instance before applying — a field id string alone can't carry that.
function primaryButtonFieldsByBlock(schema) {
  const map = {};
  for (const b of schema.blocks || []) {
    const colorFields = (b.settings || []).filter((s) => s.type === 'color' && s.id && !/_dark$/.test(s.id));
    const primary = colorFields.filter((s) => PRIMARY_BUTTON_BG_PATTERN.test(s.id));
    const broad = colorFields.filter((s) => /button/i.test(s.id) && !/hover|text|secondary|link/i.test(s.id));
    map[b.type] = primary.length ? primary : broad;
  }
  return map;
}

// Mutates `sectionObject` in place (same auto-correct philosophy as sanitizeSection: don't just
// report a gap and make the caller spend another turn fixing it — apply the one obviously-correct
// value directly, and say what changed) whenever exactly ONE color field and ONE Figma fill/button
// are in play, so there's no ambiguity about which field the value belongs to. Anything with more
// than one candidate on either side is left alone and only reported, since guessing which of several
// fields/fills pair up would be exactly the kind of silent wrong-guess this module exists to catch.
// Returns a list of plain-language notes — "Auto-applied ..." for what it changed, "Flagged ..." for
// what it could only report.
function auditSectionAgainstFigma(figmaNodes, sectionObject, schema) {
  const notes = [];
  const nodes = (Array.isArray(figmaNodes) ? figmaNodes : [figmaNodes]).filter(Boolean);
  if (!nodes.length || !schema) return notes;

  const bgFieldIds = collectColorFieldIds(schema).filter((id) => /background|^bg_|_bg$/i.test(id));
  const buttonFieldsByBlock = primaryButtonFieldsByBlock(schema);
  const allStringsBlob = deepStringValues(sectionObject).join('\n');

  const MIN_AREA_SHARE = 0.15; // node must cover ≥15% of the fetched frame's area to count as a background candidate

  // A "background-like" field isn't always on the section itself — e.g. slideshow.liquid's
  // content_background_color lives on the slide BLOCK, for the text panel's own tinted backdrop.
  // Build one flat list of every such slot, section-level and block-level, each with a getter/setter
  // so the matching logic below doesn't need to care which kind it's looking at. Block-level slots
  // gated behind a currently-false visible_if (e.g. only shown when some other toggle is on) are
  // skipped entirely — they're not real candidates for whatever the design's fill actually is.
  const bgSlots = bgFieldIds.map((id) => ({
    label: `settings.${id}`,
    get: () => sectionObject.settings?.[id],
    set: (v) => { sectionObject.settings[id] = v; },
  }));
  for (const b of schema.blocks || []) {
    const blockBgFields = (b.settings || []).filter(
      (s) => s.type === 'color' && s.id && !/_dark$/.test(s.id) && /background|^bg_|_bg$/i.test(s.id)
    );
    for (const [blockKey, block] of Object.entries(sectionObject.blocks || {})) {
      if (block.type !== b.type) continue;
      for (const fieldDef of blockBgFields) {
        if (!isFieldActive(fieldDef, block.settings)) continue;
        const id = fieldDef.id;
        bgSlots.push({
          label: `blocks.${blockKey}.settings.${id}`,
          get: () => block.settings?.[id],
          set: (v) => { block.settings[id] = v; },
        });
      }
    }
  }

  for (const node of nodes) {
    // --- background color ---
    if (bgSlots.length) {
      const rootArea = node.box ? node.box.width * node.box.height : null;
      const candidateFills = collectSolidFills(node).filter(({ box }) => {
        if (!rootArea || !box) return true;
        return box.width * box.height >= rootArea * MIN_AREA_SHARE;
      });
      const distinctFills = [...new Map(candidateFills.map((c) => [c.fill, c])).values()];
      const unsetSlots = bgSlots.filter((slot) => !normalizeColor(slot.get()));
      const setValues = bgSlots.map((slot) => normalizeColor(slot.get())).filter(Boolean);

      for (const { name, id, fill } of distinctFills) {
        const alreadyMatches = setValues.some((v) => (hexDistance(v, fill) ?? 999) < 20);
        if (alreadyMatches) continue;
        if (distinctFills.length === 1 && unsetSlots.length === 1) {
          unsetSlots[0].set(fill);
          notes.push(`Auto-applied from Figma: ${unsetSlots[0].label} = "${fill}" (matched solid fill on "${name}", ${id}).`);
        } else {
          const current = bgSlots.map((slot) => `${slot.label}=${slot.get() ?? 'unset'}`).join(', ');
          notes.push(
            `Flagged (ambiguous, needs review): Figma node "${name}" (${id}) has solid fill ${fill} covering a large share of the section, but background field(s) don't match (${current}) and there's more than one candidate field/fill to pair them up automatically.`
          );
        }
      }
    }

    // --- button color (per block, only when that block has exactly one ACTIVE button-color field) ---
    const buttonFills = collectButtonFills(node);
    const distinctButtonFills = [...new Map(buttonFills.map((c) => [c.fill, c])).values()];
    if (distinctButtonFills.length === 1) {
      const { name, id, fill } = distinctButtonFills[0];
      let applied = false;
      for (const block of Object.values(sectionObject.blocks || {})) {
        const fieldDefs = (buttonFieldsByBlock[block.type] || []).filter((f) => isFieldActive(f, block.settings));
        if (fieldDefs.length !== 1) continue;
        const fieldId = fieldDefs[0].id;
        const current = normalizeColor(block.settings?.[fieldId]);
        if (current && (hexDistance(current, fill) ?? 999) < 20) {
          applied = true; // already correct
          continue;
        }
        if (!current) {
          block.settings[fieldId] = fill;
          notes.push(`Auto-applied from Figma: blocks.${block.type}.settings.${fieldId} = "${fill}" (matched button fill on "${name}", ${id}).`);
          applied = true;
        }
      }
      if (!applied) {
        notes.push(
          `Flagged (ambiguous, needs review): Figma node "${name}" (${id}) is a button with solid fill ${fill}, but no single block's button-color field could be matched automatically — check manually.`
        );
      }
    } else if (distinctButtonFills.length > 1) {
      for (const { name, id, fill } of distinctButtonFills) {
        notes.push(
          `Flagged (ambiguous, needs review): multiple distinct button fills found in Figma (this one: "${name}"/${id} = ${fill}) — can't auto-match to a specific block, check manually.`
        );
      }
    }

    // --- highlight brackets: auto-apply when the run's text appears in exactly one field ---
    for (const runText of collectHighlightedRunTexts(node)) {
      const bracketed = `[${runText}]`;
      if (allStringsBlob.includes(bracketed)) continue; // already done
      const candidates = findFieldsContaining(sectionObject, runText);
      if (candidates.length === 1) {
        const { path, value } = candidates[0];
        setByPath(sectionObject, path, value.split(runText).join(bracketed));
        notes.push(`Auto-applied from Figma: wrapped "${runText}" in [brackets] at ${path.join('.')} (highlighted run under "${node.name}").`);
        const highlightPath = highlightTypeFieldPath(schema, sectionObject, path);
        if (highlightPath && getByPath(sectionObject, highlightPath) !== 'font_highlight') {
          setByPath(sectionObject, highlightPath, 'font_highlight');
          notes.push(`Auto-applied from Figma: ${highlightPath.join('.')} = "font_highlight" (paired with the bracket above).`);
        }
      } else if (candidates.length > 1) {
        notes.push(
          `Flagged (ambiguous, needs review): Figma text under "${node.name}" has a highlighted run "${runText}", and it appears in ${candidates.length} different fields — can't tell which one to bracket automatically.`
        );
      } else {
        notes.push(
          `Flagged (needs review): Figma text under "${node.name}" has a highlighted run "${runText}" but that exact text doesn't appear anywhere in the written section — check it was transcribed and the matching field uses the [bracket] highlight convention.`
        );
      }
    }

    // --- button style (primary/secondary/text-link) from the button's own fills/strokes ---
    const buttonStyleFieldsMap = buttonStyleFieldsByBlock(schema);
    for (const { name, id, style } of collectButtonStyleNodes(node)) {
      for (const block of Object.values(sectionObject.blocks || {})) {
        const fieldDefs = (buttonStyleFieldsMap[block.type] || []).filter((f) => isFieldActive(f, block.settings));
        if (fieldDefs.length !== 1) continue; // ambiguous (0 or >1 ACTIVE style fields on this block)
        const fieldId = fieldDefs[0].id;
        if (block.settings?.[fieldId] === style) continue; // already correct
        const previous = block.settings?.[fieldId];
        block.settings[fieldId] = style;
        notes.push(
          `Auto-applied from Figma: blocks.${block.type}.settings.${fieldId} = "${style}" (was "${previous}" — derived from "${name}" (${id})'s own fills/strokes).`
        );
      }
    }

    // --- "Scroll Bar"/"Carousel" decorative instance → swiper_on_mobile should be true ---
    if (collectCarouselIndicators(node).length) {
      const swiperField = (schema.settings || []).find((s) => s.type === 'checkbox' && s.id && /swiper_on_mobile/i.test(s.id));
      if (swiperField && sectionObject.settings?.[swiperField.id] !== true) {
        sectionObject.settings[swiperField.id] = true;
        notes.push(`Auto-applied from Figma: settings.${swiperField.id} = true (Figma shows a Scroll Bar/Carousel indicator under this row).`);
      }
    }

    // --- "Rating Star" instance → show_rating / icon_star toggle ---
    if (collectRatingIndicators(node).length) {
      for (const s of schema.settings || []) {
        if (s.type === 'checkbox' && s.id === 'show_rating' && sectionObject.settings?.show_rating !== true) {
          sectionObject.settings.show_rating = true;
          notes.push(`Auto-applied from Figma: settings.show_rating = true (Figma shows a Rating Star instance).`);
        }
      }
      for (const b of schema.blocks || []) {
        const hasShowRating = (b.settings || []).some((s) => s.id === 'show_rating' && s.type === 'checkbox');
        const iconStarField = (b.settings || []).find((s) => s.id === 'icon_star' && s.type === 'select');
        for (const [blockKey, block] of Object.entries(sectionObject.blocks || {})) {
          if (block.type !== b.type) continue;
          if (hasShowRating && block.settings?.show_rating !== true) {
            block.settings.show_rating = true;
            notes.push(`Auto-applied from Figma: blocks.${blockKey}.settings.show_rating = true (Figma shows a Rating Star instance).`);
          }
          if (iconStarField) {
            const starOption = (iconStarField.options || []).find((o) => /^5.?star$/i.test(typeof o === 'string' ? o : o.value));
            const starValue = starOption ? (typeof starOption === 'string' ? starOption : starOption.value) : null;
            if (starValue && block.settings?.icon_star !== starValue) {
              block.settings.icon_star = starValue;
              notes.push(`Auto-applied from Figma: blocks.${blockKey}.settings.icon_star = "${starValue}" (Figma shows a Rating Star instance).`);
            }
          }
        }
      }
    }

    // --- block count vs pagination counter (can't safely auto-duplicate: no way to know what
    // placeholder content the extra blocks should carry) ---
    for (const counter of collectPaginationCounters(node)) {
      const blockCount = Object.keys(sectionObject.blocks || {}).length;
      if (counter.total && blockCount && blockCount < counter.total) {
        notes.push(
          `Flagged (needs review): Figma node "${node.name}" shows a "${counter.raw}" pagination counter (implying at least ${counter.total} repeated items) but this section only has ${blockCount} block(s) — consider duplicating blocks to match.`
        );
      }
    }
  }

  // De-duplicate identical notes across multiple fetched nodes covering overlapping subtrees.
  return [...new Set(notes)];
}

// Reports (never fills) every schema field NOT explicitly present in the written section — this is
// deliberately NOT an auto-fill: writing the schema's own default value explicitly changes nothing
// about how Shopify renders (an absent field already falls back to that exact same default), so
// "filling it in" would just be cosmetic. What actually matters is forcing a look at fields whose
// default is a non-blank PLACEHOLDER (a numbered icon/goal slot defaulting to a real icon or a
// non-zero value) — leaving one of THOSE untouched renders an extra visible item the design never
// showed. Flags those with higher severity; lists everything else too, for completeness.
function reportMissingFields(sectionObject, schema) {
  const notes = [];
  const isDark = (id) => /_dark$/.test(id) || /\(dark\)/i.test(id);
  const looksLikePlaceholder = (s) => {
    if (s.type === 'select' && s.default && s.default !== (s.options || [])[0]?.value) return false; // ambiguous, skip severity bump
    if ((s.type === 'select' || s.type === 'radio') && typeof s.default === 'string' && s.default && s.default !== 'none') return true;
    if (s.type === 'text' && typeof s.default === 'string' && s.default.trim()) return true;
    if (s.type === 'range' && typeof s.default === 'number' && s.default !== 0 && (s.min ?? 0) !== s.default) return true;
    return false;
  };

  const missingSection = (schema.settings || []).filter((s) => s.id && !isDark(s.id) && !(s.id in (sectionObject.settings || {})));
  if (missingSection.length) {
    const risky = missingSection.filter(looksLikePlaceholder);
    if (risky.length) {
      notes.push(
        `Flagged (placeholder risk): settings field(s) [${risky.map((s) => `${s.id}=default:"${s.default}"`).join(', ')}] weren't written explicitly — Shopify will render their non-blank schema default as real content, not blank.`
      );
    }
    const rest = missingSection.filter((s) => !looksLikePlaceholder(s));
    if (rest.length) notes.push(`Flagged (not written): settings field(s) left at schema default: ${rest.map((s) => s.id).join(', ')}.`);
  }

  const blockDefs = {};
  for (const b of schema.blocks || []) blockDefs[b.type] = b.settings || [];
  for (const [blockKey, block] of Object.entries(sectionObject.blocks || {})) {
    const missing = (blockDefs[block.type] || []).filter((s) => s.id && !isDark(s.id) && !(s.id in (block.settings || {})));
    if (!missing.length) continue;
    const risky = missing.filter(looksLikePlaceholder);
    if (risky.length) {
      notes.push(
        `Flagged (placeholder risk): blocks.${blockKey} (${block.type}) field(s) [${risky.map((s) => `${s.id}=default:"${s.default}"`).join(', ')}] weren't written explicitly — Shopify will render their non-blank schema default as real content, not blank.`
      );
    }
    const rest = missing.filter((s) => !looksLikePlaceholder(s));
    if (rest.length) notes.push(`Flagged (not written): blocks.${blockKey} (${block.type}) field(s) left at schema default: ${rest.map((s) => s.id).join(', ')}.`);
  }

  return notes;
}

// Flags an icon-select field (id matching /icon/i, type "select", with a "none" option — this
// theme's standard "icon" + "another_icon" + "custom_icon" trio) set to a real built-in value while
// its sibling "custom_icon" (SVG) field is empty AND fetch_figma_icon_svg was never called this
// whole conversation. Doesn't know whether a matching Figma vector actually existed to export (that
// requires reading the design, which this function doesn't have) — only that the tool that would
// have exported one was never even tried, which is the exact "guessed a built-in icon instead of
// fetching the real vector" failure mode the MAPPING_RULES rule warns against.
function reportUnexportedIcons(sectionObject, schema, svgExportCount) {
  const notes = [];
  if (svgExportCount > 0) return notes; // at least one real export was attempted this conversation

  const checkFields = (fieldDefs, settingsObj, where) => {
    const iconField = fieldDefs.find((s) => s.type === 'select' && /icon/i.test(s.id || '') && (s.options || []).some((o) => (typeof o === 'string' ? o : o.value) === 'none'));
    const customIconField = fieldDefs.find((s) => s.type === 'html' && s.id === 'custom_icon');
    if (!iconField) return;
    const iconValue = settingsObj?.[iconField.id];
    if (!iconValue || iconValue === 'none') return;
    if (customIconField && settingsObj?.[customIconField.id]) return; // a real SVG IS present
    notes.push(
      `Flagged (possible guessed icon): ${where}.${iconField.id} = "${iconValue}" (a built-in icon), but fetch_figma_icon_svg was never called this conversation and ${customIconField ? `${customIconField.id} is empty` : 'there is no custom_icon field to hold one'} — verify the design doesn't have a specific Figma vector that should have been exported instead.`
    );
  };

  checkFields(schema.settings || [], sectionObject.settings, 'settings');
  const blockDefs = {};
  for (const b of schema.blocks || []) blockDefs[b.type] = b.settings || [];
  for (const [blockKey, block] of Object.entries(sectionObject.blocks || {})) {
    checkFields(blockDefs[block.type] || [], block.settings, `blocks.${blockKey}.settings`);
  }

  return notes;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Cached per store/theme (the file tree and locale strings don't change mid-run, and this walks +
// parses every sections/*.liquid file, which isn't cheap to redo on every single section write).
const sectionNameIndexCache = new Map();

// A section's real ADMIN-FACING name (its schema's own "name" — what shows in the Theme Editor's
// section picker, e.g. "Media with text" for image-with-text.liquid, "Text columns with icons" for
// multicolumn.liquid) is frequently a completely different set of words than its filename — checked
// across this theme's own real files, 40 of 107 section files have a name/filename mismatch. A
// designer naming a Figma layer almost always describes what they SEE (the admin section name, if
// they've used the theme editor at all), not the developer-facing file path, so matching only
// against filenames misses a large share of real, correct matches entirely (e.g. a layer literally
// named "Text columns with icons" finds no file by filename-slug matching alone, since the real
// file is "multicolumn.liquid" — but matches immediately against the resolved schema name).
function buildSectionNameIndex(store, themeId) {
  const cacheKey = `${store}::${themeId}`;
  if (sectionNameIndexCache.has(cacheKey)) return sectionNameIndexCache.get(cacheKey);

  const { getThemeDir } = require('./cli');
  const { loadLocaleMap, resolveKey } = require('./locale-resolve');
  const sectionsDir = path.join(getThemeDir(store, themeId), 'sections');
  const index = { byFilename: new Map(), byName: new Map(), displayNameByType: new Map() };

  if (fs.existsSync(sectionsDir)) {
    const localeMap = loadLocaleMap(store, themeId);
    const files = fs.readdirSync(sectionsDir).filter((f) => f.endsWith('.liquid'));
    for (const file of files) {
      const type = file.replace(/\.liquid$/, '');
      index.byFilename.set(slugify(type), type);

      const raw = fs.readFileSync(path.join(sectionsDir, file), 'utf8');
      const start = raw.indexOf('{% schema %}');
      const end = raw.indexOf('{% endschema %}');
      if (start === -1 || end === -1) continue;
      let schema;
      try {
        schema = JSON.parse(raw.slice(start + 12, end));
      } catch {
        try {
          schema = JSON.parse(raw.slice(start + 12, end).replace(/,(\s*[}\]])/g, '$1'));
        } catch {
          continue;
        }
      }
      if (!schema.name) continue;
      const resolvedName = schema.name.startsWith('t:') ? resolveKey(localeMap, schema.name) : schema.name;
      if (resolvedName) {
        index.byName.set(slugify(resolvedName), type);
        index.displayNameByType.set(type, resolvedName);
      }
    }
  }

  sectionNameIndexCache.set(cacheKey, index);
  return index;
}

// Compares the Figma node's own layer name against real section files in this theme, two ways: its
// filename slug (a literal or near-literal filename match) AND its resolved admin-facing schema
// "name" (see buildSectionNameIndex for why the latter catches a large class of matches the former
// alone misses). Either one pointing to a DIFFERENT file than what was actually used is worth a
// second look — a generic/misleading Figma layer name can lead to picking a
// semantically-plausible-but-wrong file (this happened repeatedly across theme audits: "social-feeds"
// chosen over the literally matching "video-shopping.liquid"; "collection-list" chosen for a frame
// that needed a per-tile description field only "text-column-with-image.liquid" has).
function findBetterFileMatch(store, themeId, figmaNodeName, chosenType) {
  if (!figmaNodeName) return null;
  const slug = slugify(figmaNodeName);
  if (!slug || slug === chosenType) return null;

  const index = buildSectionNameIndex(store, themeId);
  const byFilename = index.byFilename.get(slug);
  const byName = index.byName.get(slug);

  if (byFilename && byFilename !== chosenType) {
    return `Figma layer name "${figmaNodeName}" slugifies to "${slug}", which matches an existing section file "${byFilename}.liquid" by filename — this section was written as type "${chosenType}" instead. If "${chosenType}" doesn't fully cover the content (e.g. a field the design needs isn't in its schema), "${byFilename}" may be the better fit.`;
  }
  if (byName && byName !== chosenType) {
    return `Figma layer name "${figmaNodeName}" matches the ADMIN-FACING name of section file "${byName}.liquid" (its schema's own "name", not its filename) — this section was written as type "${chosenType}" instead. A designer naming a Figma layer typically describes what they see in the theme editor, so this is usually the better fit; verify "${byName}"'s schema actually covers the content before switching.`;
  }
  return null;
}

// Returns { "multicolumn": "Text columns with icons", ... } for every sections/*.liquid file that
// declares a schema "name" — used to show the model BOTH names up front (in the file list it reads
// before picking one) instead of only after a wrong guess. Same cached index findBetterFileMatch
// uses, so building this list doesn't re-scan the theme a second time.
function getSectionDisplayNames(store, themeId) {
  return buildSectionNameIndex(store, themeId).displayNameByType;
}

module.exports = {
  auditSectionAgainstFigma,
  findBetterFileMatch,
  reportMissingFields,
  getSectionDisplayNames,
  reportUnexportedIcons,
};
