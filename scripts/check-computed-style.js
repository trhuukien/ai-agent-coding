#!/usr/bin/env node
// Verify that the LIVE rendered page's actual computed CSS (color, font-size, section padding)
// matches what was configured — a deterministic, code-only check, never a vision guess. This is
// the "config-vs-render" half of step 7's Auto-verify FE: the Figma-vs-config comparison already
// happens at write time (apply-section.js's own audit); what stays unverified until now is whether
// the CONFIGURED value actually renders correctly (token not applied, CSS override, wrong CSS
// variable, a stale cache) — this script answers exactly that, for a handful of key properties per
// section, at near-zero cost (no model call, just computed-style reads).
//
// Usage:
//   node scripts/check-computed-style.js <store> <themeId> <path> <checksJsonFile> [password] [viewport]
//   checksJsonFile: JSON array of checks, each:
//     {
//       "sectionKey": "template--xxx__hero",      // same key screenshot-theme-page.js prints
//       "selector": "h1",                          // CSS selector scoped inside that section
//       "property": "color" | "background-color" | "font-size" | "font-weight" |
//                   "padding-top" | "padding-bottom" | "font-style" | "text-transform" |
//                   "text-decoration-line",
//       "expected": "#0d1b2a" | "24px" | "500" | "italic" | "uppercase",  // real expected value —
//                                                    // YOU compute this ahead of time from the
//                                                    // actual config/Figma data (hex color, a
//                                                    // resolved px number, a real font.weight, a
//                                                    // real font.style/italic flag from the Figma
//                                                    // TEXT node) — this script only compares, it
//                                                    // never re-derives a % scale into px itself
//       "tolerancePx": 2                            // optional, only for px-valued properties —
//                                                    // allow small rounding drift (rem math, etc.)
//     }
//   viewport: optional "WIDTHxHEIGHT" (see screenshot-theme-page.js), defaults to 1440x900.
//
//   CONFIRMED REAL GOTCHA for padding-top/padding-bottom checks: an empty `selector` targets
//   `[id*="<sectionKey>"]` — Shopify's own outer `<section id="shopify-section-...">` wrapper. On at
//   least one real theme (confirmed on the Eliana Luxury / "Eurus" theme), that OUTER wrapper always
//   computes padding as 0/0 regardless of the section's actual configured padding — the real padding
//   lives on an INNER element carrying a theme-generated class like
//   `.section-padding-<full-section-key>` (a dynamically injected `<style>` block targets that class,
//   not the outer wrapper). Leaving `selector` blank for a padding check on such a theme silently
//   reads the wrong element and always reports 0/0, which can look like a false "matches Figma's
//   flush design" pass. Before trusting an empty-selector padding check, inspect one real section's
//   rendered HTML/CSS (view source, or `page.evaluate` reading `document.querySelector('[id*="key"]').outerHTML`)
//   to confirm which element actually carries the padding on THIS theme — if it's an inner
//   `.section-padding-*` class, pass that class explicitly as `selector` instead of leaving it blank.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { chromium } = require('playwright');

const [, , storeArg, themeId, pagePath, checksFile, password, viewportArg] = process.argv;

if (!storeArg || !themeId || !pagePath || !checksFile) {
  console.error(
    'Usage: node scripts/check-computed-style.js <store> <themeId> <path> <checksJsonFile> [password] [viewport]'
  );
  process.exit(1);
}

const domain = storeArg.includes('.') ? storeArg : `${storeArg}.myshopify.com`;

let viewportWidth = 1440;
let viewportHeight = 900;
if (viewportArg) {
  const m = viewportArg.match(/^(\d+)x(\d+)$/);
  if (!m) {
    console.error(`ERROR: viewport "${viewportArg}" must look like "390x844".`);
    process.exit(1);
  }
  viewportWidth = parseInt(m[1], 10);
  viewportHeight = parseInt(m[2], 10);
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function parseRgbString(s) {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  return m[1].split(',').slice(0, 3).map((n) => parseInt(n.trim(), 10));
}

function colorsMatch(expected, actualComputed) {
  const expectedRgb = expected.startsWith('#') ? hexToRgb(expected) : parseRgbString(expected);
  const actualRgb = parseRgbString(actualComputed);
  if (!expectedRgb || !actualRgb) return { match: false, reason: 'unparseable color' };
  const match = expectedRgb.every((v, i) => v === actualRgb[i]);
  return { match, expectedRgb, actualRgb };
}

function pxMatch(expected, actual, tolerancePx = 0) {
  const e = parseFloat(expected);
  const a = parseFloat(actual);
  if (Number.isNaN(e) || Number.isNaN(a)) return { match: false, reason: 'unparseable px value' };
  return { match: Math.abs(e - a) <= tolerancePx, diff: Math.abs(e - a) };
}

// Properties whose computed value is a plain keyword, not a color or a number — e.g. italic vs
// normal (`font-style`), uppercase/none (`text-transform`), underline/none
// (`text-decoration-line`). parseFloat on "italic" is NaN, so these must never go through pxMatch.
const KEYWORD_PROPERTIES = new Set(['font-style', 'text-transform', 'text-decoration-line', 'text-decoration']);

function keywordMatch(expected, actual) {
  return { match: expected.trim().toLowerCase() === actual.trim().toLowerCase() };
}

(async () => {
  let browser;
  try {
    const checks = JSON.parse(fs.readFileSync(checksFile, 'utf8'));
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight } });
    const page = await context.newPage();

    if (password) {
      // Submit directly via a same-context API POST rather than driving the /password PAGE's UI —
      // see screenshot-theme-page.js's matching fix for the full explanation: on a store that
      // hasn't picked a Shopify plan yet, GET /password redirects straight to the "Opening soon"
      // home page before any form renders, and that page's own password entry lives behind a
      // JS-driven modal that didn't reliably become interactive under automation. `context.request`
      // shares the same cookie jar as `page`, so the resulting cookie is already attached below.
      const passResp = await context.request.post(`https://${domain}/password`, {
        form: { form_type: 'storefront_password', utf8: '✓', password },
      });
      if (passResp.status() >= 400) {
        console.error(`Warning: password POST to /password returned status ${passResp.status()} — password may be wrong.`);
      }
    }

    await page.goto(`https://${domain}${pagePath}?preview_theme_id=${themeId}`, {
      waitUntil: 'networkidle',
      timeout: 45000,
    });

    let passCount = 0;
    for (const check of checks) {
      const { sectionKey, selector, property, expected, tolerancePx = 1 } = check;
      // Empty/omitted selector means "the section wrapper element itself" (e.g. for
      // padding-top/padding-bottom checks on the section, not a child inside it).
      // CONFIRMED REAL BUG (fixed here): naively prefixing a multi-part selector list like
      // "h2, h3" with string concatenation produces "[id*=x] h2, h3" — a CSS selector LIST where
      // only the FIRST part is actually scoped; the second part ("h3") matches ANY h3 on the whole
      // page, unscoped. `page.$()` then silently returns whichever matches first in document
      // order, which can be a completely unrelated element. Each comma-separated part must get its
      // own prefix.
      const prefix = `[id*="${sectionKey}"]`;
      const fullSelector = selector
        ? selector.split(',').map((s) => `${prefix} ${s.trim()}`).join(', ')
        : prefix;
      const el = await page.$(fullSelector);
      if (!el) {
        console.log(`FAIL  ${sectionKey} ${selector} ${property} -> element not found`);
        continue;
      }
      const actual = await el.evaluate((node, prop) => getComputedStyle(node)[prop], property);

      let result;
      if (property === 'color' || property === 'background-color') {
        result = colorsMatch(expected, actual);
      } else if (KEYWORD_PROPERTIES.has(property)) {
        result = keywordMatch(expected, actual);
      } else {
        result = pxMatch(expected, actual, tolerancePx);
      }

      if (result.match) {
        passCount += 1;
        console.log(`PASS  ${sectionKey} ${selector} ${property} -> ${actual} (expected ${expected})`);
      } else {
        console.log(`FAIL  ${sectionKey} ${selector} ${property} -> ${actual} (expected ${expected})`);
      }
    }
    console.log(`\n${passCount}/${checks.length} checks passed.`);
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
