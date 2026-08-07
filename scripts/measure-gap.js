#!/usr/bin/env node
// Measure the real pixel gap between the first two visibly-sized children of the shallowest
// repeated-block container inside a section — the itemSpacing/gap check AUTOTEST.md step 4 calls
// for (no dedicated script existed before; this factors out the generic BFS heuristic so every
// caller shares one implementation instead of re-deriving it, and shares screenshot-theme-page.js's
// fixed password-POST flow instead of the old broken toggle-click one).
//
// RELIABILITY CAVEAT (see AUTOTEST.md's own gotcha): this heuristic works well for a plain
// repeated-block grid/list (product/collection cards, logo rows) but gives false near-zero
// readings on image/carousel/marquee-shaped sections. Trust a result only when `containerClass`
// plausibly looks like a real item-repeating wrapper.
//
// Usage:
//   node scripts/measure-gap.js <store> <themeId> <path> <sectionKey> [password] [viewport]
require('dotenv').config({ quiet: true });
const { chromium } = require('playwright');

const [, , storeArg, themeId, pagePath, sectionKey, password, viewportArg] = process.argv;

if (!storeArg || !themeId || !pagePath || !sectionKey) {
  console.error('Usage: node scripts/measure-gap.js <store> <themeId> <path> <sectionKey> [password] [viewport]');
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

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight } });
    const page = await context.newPage();

    if (password) {
      const passResp = await context.request.post(`https://${domain}/password`, {
        form: { form_type: 'storefront_password', utf8: '✓', password },
      });
      if (passResp.status() >= 400) {
        console.error(`Warning: password POST returned status ${passResp.status()} — password may be wrong.`);
      }
    }

    // 'networkidle' can hang past any reasonable timeout on a real store running a chat widget,
    // analytics beacon, or other persistent/polling connection — see screenshot-theme-page.js's
    // own fix for this same real gotcha.
    await page.goto(`https://${domain}${pagePath}?preview_theme_id=${themeId}`, {
      waitUntil: 'load',
      timeout: 45000,
    });
    await page.waitForTimeout(1500);

    const result = await page.evaluate((key) => {
      const section = document.querySelector(`[id*="${key}"]`);
      if (!section) return { found: false, reason: 'section not found' };

      // BFS down from the section root looking for the shallowest element with >=2 visibly-sized
      // (non-zero box) children — that's the presumed item-repeating container.
      const queue = [section];
      while (queue.length) {
        const el = queue.shift();
        const kids = Array.from(el.children).filter((c) => {
          const r = c.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (kids.length >= 2) {
          const r1 = kids[0].getBoundingClientRect();
          const r2 = kids[1].getBoundingClientRect();
          // Horizontal gap if side-by-side, vertical gap if stacked — pick whichever axis the
          // two boxes are actually separated on.
          const horizGap = r2.left - r1.right;
          const vertGap = r2.top - r1.bottom;
          const gap = Math.abs(horizGap) >= Math.abs(vertGap) ? horizGap : vertGap;
          return {
            found: true,
            containerClass: el.className || '(no class)',
            containerTag: el.tagName.toLowerCase(),
            childCount: kids.length,
            gap: Math.round(gap),
          };
        }
        kids.forEach((k) => queue.push(k));
      }
      return { found: false, reason: 'no container with >=2 sized children found' };
    }, sectionKey);

    console.log(JSON.stringify(result));
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
