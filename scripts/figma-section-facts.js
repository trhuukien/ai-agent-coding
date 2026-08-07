#!/usr/bin/env node
// Pre-compute the handful of "dev facts" a human would read off a Figma section at a glance
// (background color, column count, full-width or not, padding/gap, alignment, all text content)
// via CODE, from an already-fetched section JSON (figma-fetch-node.js/figma-fetch-multi.js output)
// — instead of handing the whole nested JSON tree to the model and burning tokens re-deriving these
// same handful of facts by reasoning over it every time.
//
// This is a FAST PATH for the common/clean case, not a replacement for reading the real JSON.
// Every fact is reported with a `confidence` — "confirmed" (safe to trust, computed from an
// unambiguous real property) or "ambiguous" (the structure didn't match this script's assumptions;
// a `reason` explains why, and the model should fall back to reading the raw section JSON, or the
// rendered PNG, for that specific fact rather than trusting a guess). Never silently emit a
// plausible-looking wrong value — see the `reason` strings below for the real, confirmed failure
// modes this guards against (e.g. a mobile single-card carousel's internal badge row getting
// mistaken for a multi-column product grid — confirmed real case on FC-166's "Feature Collection").
//
// Usage:
//   node scripts/figma-section-facts.js <sectionJsonFile> [pageWidthPx]
//   sectionJsonFile: JSON file holding ONE section node, in figma-fetch-node.js's own output shape
//     ({ id, name, type, box, fills, layoutMode, itemSpacing, padding, primaryAxisAlign,
//        counterAxisAlign, children[] }) — fetch at FULL depth (no depth arg) for this section node
//     specifically; a shallow multi-page scan won't have the nested detail this script needs.
//   pageWidthPx: optional — the parent page frame's own box.width, for the full-width comparison.
//     Omit to skip that specific fact (reported ambiguous, "no page width given").
require('dotenv').config({ quiet: true });
const fs = require('fs');

const [, , sectionFile, pageWidthArg] = process.argv;
if (!sectionFile) {
  console.error('Usage: node scripts/figma-section-facts.js <sectionJsonFile> [pageWidthPx]');
  process.exit(1);
}

const section = JSON.parse(fs.readFileSync(sectionFile, 'utf8'));
const pageWidth = pageWidthArg ? parseFloat(pageWidthArg) : null;

function fact(value, confidence, reason) {
  const out = { value, confidence };
  if (reason) out.reason = reason;
  return out;
}

// ─── background ────────────────────────────────────────────────────────────
// A section's visible background is usually its own solid fill — but some designs put the color
// on a separate full-bleed rectangle sitting behind everything else instead of the section frame's
// own fill (confirmed real pattern, not hypothetical). Check the section's own fills first; if
// none, check whether exactly one direct child is a large solid-fill rectangle covering most of the
// section's own box — if more than one candidate or none at all, don't guess.
function firstSolidHex(fills) {
  if (!Array.isArray(fills)) return null;
  return fills.find((f) => typeof f === 'string' && /^#[0-9a-f]{6,8}$/i.test(f)) || null;
}

// "ambiguous" below always means the same concrete, CHEAP next step: read this one fact off the
// section's rendered PNG (figma-fetch-image.js already renders it for the vision layout-check pass
// — this isn't extra work, just reusing an image that gets looked at anyway). Vision is the right
// tool for anything that's genuinely a rendered/visual question (how many items show per row, is
// this a swipeable carousel) rather than a structural one — never spend effort trying to make the
// JSON side answer those instead.
const READ_FROM_IMAGE = 'read from the section’s already-rendered PNG (figma-fetch-image.js) — this is a visual question, not a structural one, and the image is already being looked at for other layout facts anyway';

function computeBackground(sec) {
  const ownHex = firstSolidHex(sec.fills);
  if (ownHex) return fact(ownHex, 'confirmed', 'section’s own fill');

  if (!Array.isArray(sec.children) || !sec.box) {
    return fact(null, 'ambiguous', `no own fill, no children to check for a backing rectangle — ${READ_FROM_IMAGE}`);
  }
  const secArea = sec.box.width * sec.box.height;
  const candidates = sec.children.filter((c) => {
    const hex = firstSolidHex(c.fills);
    if (!hex || !c.box) return false;
    const coverage = (c.box.width * c.box.height) / secArea;
    return coverage >= 0.6;
  });
  if (candidates.length === 1) {
    return fact(firstSolidHex(candidates[0].fills), 'child-fill', `backing rectangle "${candidates[0].name}"`);
  }
  if (candidates.length > 1) {
    return fact(null, 'ambiguous', `${candidates.length} large-fill children found, can’t tell which is the real background — ${READ_FROM_IMAGE}`);
  }
  return fact(null, 'ambiguous', `no solid fill found on the section or any large child (may be transparent/image-only) — ${READ_FROM_IMAGE}`);
}

// ─── full width ─────────────────────────────────────────────────────────────
// Pure box-width math, no image needed — Figma gives exact pixel widths, so this one's ambiguous
// case (a ratio in the unclear middle band) still resolves fastest by glancing at the same rendered
// PNG rather than re-deriving it from more JSON math.
function computeFullWidth(sec, pageW) {
  if (pageW == null || !sec.box) {
    return fact(null, 'ambiguous', 'no page width given to compare against — pass the page frame’s own box.width');
  }
  const ratio = sec.box.width / pageW;
  if (ratio >= 0.98) return fact(true, 'confirmed', `section width ${sec.box.width}px ≈ page width ${pageW}px`);
  if (ratio <= 0.9) return fact(false, 'confirmed', `section width ${sec.box.width}px is ${Math.round(ratio * 100)}% of page width ${pageW}px`);
  return fact(null, 'ambiguous', `section width is ${Math.round(ratio * 100)}% of page width, too close to call from math alone — ${READ_FROM_IMAGE}`);
}

// ─── columns ────────────────────────────────────────────────────────────────
// Only trust a column count computed from JSON when the section's OWN direct children (not some
// arbitrarily-nested frame found by searching deeper) are structurally homogeneous — same type,
// similar box size — laid out in a single row (HORIZONTAL). A HORIZONTAL frame found deeper in the
// tree is very often a single card's OWN internal layout (an icon+label row, a price+badge row), not
// a repeated grid of cards — confirmed real case: FC-166's "Feature Collection" section is a mobile
// single-card carousel whose only HORIZONTAL frame is one card's internal badge row, not a 3-column
// grid. But this isn't really a JSON problem to begin with — "how many items show per row" and
// "is this a swipeable carousel" are visual/rendered questions (Figma's JSON has no "carousel"
// concept at all, and a wrapping/scrolling row's total child count isn't the same thing as what
// renders per viewport) — every ambiguous case here should go straight to the rendered image, not to
// more JSON digging.
function boxesSimilar(a, b, tolPct = 0.25) {
  if (!a || !b) return false;
  const wDiff = Math.abs(a.width - b.width) / Math.max(a.width, b.width, 1);
  const hDiff = Math.abs(a.height - b.height) / Math.max(a.height, b.height, 1);
  return wDiff <= tolPct && hDiff <= tolPct;
}

function computeColumns(sec) {
  if (!Array.isArray(sec.children) || sec.children.length < 2) {
    return fact(null, 'ambiguous', `fewer than 2 direct children — not a repeated-item row — ${READ_FROM_IMAGE}`);
  }
  if (sec.layoutMode !== 'HORIZONTAL') {
    return fact(
      null,
      'ambiguous',
      `section's own layoutMode is "${sec.layoutMode || 'NONE'}", not HORIZONTAL (likely a single-card/carousel ` +
        `section, or the repeated-item row is nested deeper than this script checks) — ${READ_FROM_IMAGE}`
    );
  }
  const first = sec.children[0];
  const allSimilar = sec.children.every((c) => c.type === first.type && boxesSimilar(c.box, first.box));
  if (!allSimilar) {
    return fact(null, 'ambiguous', `direct children are not structurally similar in size/type, not a uniform grid — ${READ_FROM_IMAGE}`);
  }
  return fact(sec.children.length, 'confirmed', `${sec.children.length} structurally-similar HORIZONTAL children`);
}

// ─── text content (recursive, cheap, high-value) ───────────────────────────
function collectTexts(node, out) {
  if (node.type === 'TEXT' && node.characters) out.push(node.characters);
  if (Array.isArray(node.children)) node.children.forEach((c) => collectTexts(c, out));
}

// ─── assemble ───────────────────────────────────────────────────────────────
const texts = [];
collectTexts(section, texts);

const facts = {
  sectionId: section.id,
  sectionName: section.name,
  background: computeBackground(section),
  fullWidth: computeFullWidth(section, pageWidth),
  columns: computeColumns(section),
  padding: section.padding
    ? fact(section.padding, 'confirmed', 'real auto-layout padding')
    : fact(null, 'ambiguous', `no auto-layout padding on this node (layoutMode: ${section.layoutMode || 'NONE'})`),
  itemSpacing: section.itemSpacing != null
    ? fact(section.itemSpacing, 'confirmed', 'real auto-layout itemSpacing')
    : fact(null, 'ambiguous', `no auto-layout itemSpacing on this node (layoutMode: ${section.layoutMode || 'NONE'})`),
  alignment: {
    primary: section.primaryAxisAlign
      ? fact(section.primaryAxisAlign, 'confirmed', 'explicit, non-default value')
      : fact(section.layoutMode ? 'MIN' : null, section.layoutMode ? 'confirmed' : 'ambiguous', section.layoutMode ? 'absent key means Figma’s default (MIN)' : 'no auto-layout on this node'),
    counter: section.counterAxisAlign
      ? fact(section.counterAxisAlign, 'confirmed', 'explicit, non-default value')
      : fact(section.layoutMode ? 'MIN' : null, section.layoutMode ? 'confirmed' : 'ambiguous', section.layoutMode ? 'absent key means Figma’s default (MIN)' : 'no auto-layout on this node'),
  },
  texts,
};

const ambiguousFields = Object.entries(facts)
  .filter(([, v]) => v && typeof v === 'object' && v.confidence === 'ambiguous')
  .map(([k]) => k);
facts.needsDeeperCheck = ambiguousFields;

console.log(JSON.stringify(facts));
