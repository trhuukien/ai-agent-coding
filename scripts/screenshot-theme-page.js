#!/usr/bin/env node
// Render a theme's LIVE/preview page in a real headless browser and screenshot it
// section-by-section — the live-side counterpart to figma-fetch-image.js, used by step 7's
// Auto-verify FE pass to visually compare the actual rendered layout against the Figma section
// image already rendered during step 5. Only a real browser engine can answer layout questions
// (column count, whether a carousel actually initializes, real computed alignment) — a plain
// HTML fetch (see read-theme-file.js/cheerio-based text checks) never executes the page's JS or
// computes real layout, so this script exists specifically to cover what those can't.
//
// Each Shopify section renders inside its own `<div id="shopify-section-{section-key}">` wrapper
// (Shopify's own standard convention, not a project-specific guess) — this script screenshots each
// one of those individually, matching the one-section-per-image convention figma-fetch-image.js
// already uses, so a section's live PNG and its Figma PNG are directly comparable side by side.
//
// Usage:
//   node scripts/screenshot-theme-page.js <store> <themeId> <path> <out-dir> [password] [sectionKeys] [viewport]
//   store: bare handle or full domain (e.g. "kizchann" or "kizchann.myshopify.com")
//   path: page path to load, e.g. "/", "/products/some-handle", "/collections/some-handle"
//   out-dir: where to save "<section-key>.png" files
//   password: storefront password, if the store has one (same one-off-arg convention as
//     fetch-shopify-collections.js — never stored anywhere, supplied fresh each call)
//   sectionKeys: optional comma-separated list to screenshot only those specific sections instead
//     of every section found on the page (e.g. after a step-7 fix, re-checking just one section).
//     Pass "" (empty string) to skip this and still supply a viewport.
//   viewport: optional "WIDTHxHEIGHT" (e.g. "390x844") — match whatever viewport the Figma design
//     you're comparing against actually is (mobile-only files are common, see CLAUDE.md step 1's
//     viewport-detection rule). Defaults to 1440x900 (desktop) when omitted.
//
// NOT YET VERIFIED end-to-end against every real store's preview-access behavior: this uses
// `?preview_theme_id=<themeId>` on the public storefront domain to preview a theme that isn't
// necessarily the one currently published live. This is the same mechanism Shopify's own
// "Share preview" links use and is expected to work without a staff login, but confirm this
// resolves the CORRECT theme on the very first real use against any given store before trusting
// its output — if the store instead shows the published theme regardless of this param, that's a
// sign this store's setup needs a different preview-access approach (see project's
// never-assume-it's-flawless convention for anything not yet proven against a real store).
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const [, , storeArg, themeId, pagePath, outDir, password, sectionKeysArg, viewportArg] = process.argv;

if (!storeArg || !themeId || !pagePath || !outDir) {
  console.error(
    'Usage: node scripts/screenshot-theme-page.js <store> <themeId> <path> <out-dir> [password] [sectionKeys] [viewport]'
  );
  process.exit(1);
}

// A bare handle ("kizchann") gets ".myshopify.com" appended; anything that already looks like a
// real domain (contains a dot — ".myshopify.com" OR a custom domain like "elianaluxury.com") is
// used exactly as given, never suffixed.
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
const wantedKeys = sectionKeysArg ? sectionKeysArg.split(',').map((s) => s.trim()) : null;

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight } });
    const page = await context.newPage();

    if (password) {
      // Submit the password form directly via a same-context API POST rather than driving the
      // /password PAGE's UI. Confirmed real case: on a store that hasn't picked a Shopify plan yet,
      // GET /password itself 30x-redirects straight back to the "Opening soon" home page before any
      // form ever renders, and that home page's own password entry lives behind a JS-driven modal
      // (an "Enter using password" toggle) that didn't reliably become interactive under
      // automation. A direct POST needs neither the redirect nor the modal — Playwright's
      // `context.request` shares the same cookie jar as `page`, so the resulting session cookie
      // (scoped correctly to THIS domain, since we post to it directly) is already attached for the
      // next `page.goto`.
      const passResp = await context.request.post(`https://${domain}/password`, {
        form: { form_type: 'storefront_password', utf8: '✓', password },
      });
      if (passResp.status() >= 400) {
        console.error(`Warning: password POST to /password returned status ${passResp.status()} — password may be wrong.`);
      }
    }

    const targetUrl = `https://${domain}${pagePath}?preview_theme_id=${themeId}`;
    // 'networkidle' can hang past any reasonable timeout on a real store running a chat widget,
    // analytics beacon, or other persistent/polling connection — the network never actually goes
    // quiet. 'load' plus the script's own scroll/wait sequence below is what actually gates
    // section content, so it's a safe, faster substitute (confirmed real case, this store).
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 45000 });

    // Shopify's own theme-preview chrome (the "Draft" bar with Hide bar/Exit preview/Copy link) and
    // its platform-level privacy/consent banner are never real theme content — confirmed real case:
    // both bled into section screenshots because they're fixed-position, overlapping whatever
    // section happens to be in view at capture time. Hide them unconditionally, every capture.
    await page.addStyleTag({
      content: '#PBarNextFrameWrapper, #shopify-pc__banner { display: none !important; }',
    });

    // Many sections only render their real content once scrolled into view (IntersectionObserver-
    // driven reveal animations, not just image lazy-loading) — confirmed real case: below-the-fold
    // sections screenshotted without this step came back completely blank even though the content
    // was genuinely configured correctly. Scroll the full page once, top to bottom, before
    // screenshotting anything, so every section's reveal animation has already fired.
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let total = 0;
        const step = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          total += step;
          if (total >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 150);
      });
    });
    await page.waitForTimeout(1000);

    // Dismiss any cookie-consent banner before capturing — confirmed real case: this overlay sat
    // on top of several sections' content in a mobile-viewport capture, hiding enough of the real
    // layout underneath it to make a section's comparison unreliable. Try common
    // accept/decline/dismiss buttons; harmless no-op if no such banner exists on this theme.
    const cookieButton = page
      .locator(
        'button:has-text("Accept"), button:has-text("Decline"), button:has-text("Got it"), ' +
          '[id*="cookie" i] button, [class*="cookie" i] button'
      )
      .first();
    if (await cookieButton.count()) {
      await cookieButton.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
    }

    // Dismiss a delayed marketing/email-signup popup (e.g. a theme's "promotion-popup" section
    // triggered a few seconds after load) — confirmed real case: such a popup renders as a
    // FIXED-position overlay that isn't tied to any `[id^="shopify-section-"]` element's own
    // bounding box at the point this script scans for sticky elements, so it's never added to
    // `stickyKeys` and never hidden for other sections' captures. It then visually sits on top of
    // every section captured after it appears, all the way to the footer. Also confirmed real: the
    // theme markup can render TWO close buttons sharing the same `id` (one `hidden md:block`, one
    // `block md:hidden`, toggled by breakpoint) — a plain `#the-id` or first-match selector can
    // land on the one that's `display:none` on this viewport and silently fail to click anything.
    // Wait for the popup's own real trigger delay (seen up to ~5s) before giving up, and click
    // whichever close control is actually visible at this viewport.
    await page.waitForTimeout(6000);
    const closeButtons = page.locator(
      'button[aria-label="Close" i]:visible, button:has-text("No thanks"):visible, ' +
        '[class*="popup" i] button[class*="close" i]:visible, [id*="popup" i] button[aria-label="Close" i]:visible'
    );
    const closeCount = await closeButtons.count();
    for (let i = 0; i < closeCount; i += 1) {
      await closeButtons.nth(i).click({ timeout: 2000 }).catch(() => {});
    }
    if (closeCount) {
      await page.waitForTimeout(300);
    }

    const sectionHandles = await page.$$('[id^="shopify-section-"]');
    if (!sectionHandles.length) {
      console.error(
        'ERROR: no `[id^="shopify-section-"]` elements found on the page — this usually means ' +
          'the theme/page failed to render as expected (wrong preview_theme_id, store requires ' +
          'staff login for preview, or wrong path). Nothing screenshotted.'
      );
      process.exit(1);
    }

    // A sticky/fixed header (or any other sticky section) visually overlaps whatever scrolls
    // beneath it — confirmed real case: a sticky header pasted itself over the top of an unrelated
    // section's screenshot. Find every section that's actually sticky/fixed up front, so each OTHER
    // section's capture can hide them just for that one screenshot (and a sticky section still gets
    // captured normally when it's its own turn).
    const stickyKeys = [];
    for (const handle of sectionHandles) {
      const isSticky = await handle.evaluate((el) => {
        const pos = getComputedStyle(el).position;
        return pos === 'sticky' || pos === 'fixed';
      });
      if (isSticky) {
        const rawId = await handle.getAttribute('id');
        stickyKeys.push(rawId.replace(/^shopify-section-/, ''));
      }
    }

    fs.mkdirSync(outDir, { recursive: true });
    let savedCount = 0;
    for (const handle of sectionHandles) {
      const rawId = await handle.getAttribute('id');
      const sectionKey = rawId.replace(/^shopify-section-/, '');
      if (wantedKeys && !wantedKeys.includes(sectionKey)) continue;

      const box = await handle.boundingBox();
      if (!box || box.width === 0 || box.height === 0) {
        console.log(`${sectionKey} -> SKIPPED (zero visible area — hidden/empty section)`);
        continue;
      }

      const othersToHide = stickyKeys.filter((k) => k !== sectionKey);
      if (othersToHide.length) {
        await page.evaluate((keys) => {
          const style = document.createElement('style');
          style.id = '__temp_hide_sticky__';
          // display:none, not visibility:hidden — a sticky header with a computed height of 0 can
          // still visually paint children that overflow past its own box (confirmed real case), and
          // some of those children reset their own visibility back to visible, defeating a
          // visibility rule on the ancestor. display:none removes the whole subtree from rendering,
          // no inheritance override possible.
          style.textContent = keys.map((k) => `#shopify-section-${k}`).join(', ') + ' { display: none !important; }';
          document.head.appendChild(style);
        }, othersToHide);
      }
      // Explicitly scroll each section into view and pause before capturing — confirmed real case:
      // some themes gate content behind IntersectionObserver-driven reveal (e.g. Alpine.js
      // `x-intersect`, used to lazy-load a map iframe's `src` or fade in text) that a single fast
      // full-page pre-scroll can skip past without ever crossing the trigger threshold on a
      // rendered frame. A deliberate per-section scroll+wait right before its own screenshot is
      // what actually guarantees the observer has fired for THIS element.
      await handle.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      // A section containing an iframe (Google Maps embeds are the confirmed real case) needs much
      // more time than 400ms: the IntersectionObserver firing only means the iframe's `src` just got
      // set, not that its own remote content (map tiles) has finished loading. A too-short wait here
      // produces a screenshot of a blank/solid-color placeholder that looks like broken content even
      // though the embed is genuinely configured correctly — confirmed by re-testing the same
      // section with a longer wait and seeing real map tiles render. Give any section with an
      // iframe several extra seconds before capturing.
      const hasIframe = await handle.evaluate((el) => !!el.querySelector('iframe'));
      if (hasIframe) {
        await page.waitForTimeout(5000);
      }
      const outPath = path.join(outDir, `${sectionKey}.png`);
      await handle.screenshot({ path: outPath });
      const stat = fs.statSync(outPath);
      console.log(`${sectionKey} -> ${outPath} (${(stat.size / 1024).toFixed(0)} KB)`);
      savedCount += 1;

      if (othersToHide.length) {
        await page.evaluate(() => {
          const style = document.getElementById('__temp_hide_sticky__');
          if (style) style.remove();
        });
      }
    }

    if (wantedKeys && savedCount < wantedKeys.length) {
      const found = sectionHandles.length;
      console.error(
        `Warning: requested ${wantedKeys.length} section key(s), only matched/saved ${savedCount} ` +
          `(page had ${found} total sections rendered — check the requested keys are correct).`
      );
    }
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
