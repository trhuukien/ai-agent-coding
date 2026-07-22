#!/usr/bin/env node
// Fetch a Shopify store's REAL collection list (id, title, handle) via the storefront's public
// JSON endpoint — used so a "Featured Collection"-style section's real `collection` reference can
// be matched against actual store data instead of always being left blank. This is genuinely
// public, unauthenticated storefront data (the same JSON a theme's own AJAX code can fetch) — no
// Admin API token needed, no app install required.
//
// If the storefront is password-protected, pass the password as the second argument: this script
// submits it the same way a real visitor's browser would (POST to /password) and reuses the
// resulting session cookie for the collections.json request. Password is read only from the
// command-line argument for this one call — never stored anywhere (this project sets up many
// different stores, so a single .env entry doesn't fit; the caller supplies it fresh each time).
//
// This script does NOT do any matching — it only returns the real collection list. Matching a
// Figma section's design intent (e.g. "Most loved routines") to the right real collection is a
// judgment call to make afterward: only assign a collection when confident it's the right one;
// leave the field at schema default (blank) and flag it as a merchant follow-up otherwise — same
// "never guess/invent a real resource reference" rule already used for products/images/icons
// throughout this project.
//
// Usage:
//   node scripts/fetch-shopify-collections.js <shop-domain> [password]
//   shop-domain: bare handle or full domain (e.g. "little-bearnie" or "little-bearnie.myshopify.com")
const axios = require('axios');

const [, , shopArg, password] = process.argv;

if (!shopArg) {
  console.error('Usage: node scripts/fetch-shopify-collections.js <shop-domain> [password]');
  process.exit(1);
}

const domain = shopArg.includes('.myshopify.com') ? shopArg : `${shopArg}.myshopify.com`;
const base = `https://${domain}`;

// Set-Cookie headers carry attributes (Path=, HttpOnly, Expires=, etc.) that only make sense in a
// browser's cookie jar — a plain HTTP client just needs the "name=value" pairs joined back
// together for the next request's Cookie header.
function toCookieHeader(setCookieArray) {
  if (!setCookieArray || !setCookieArray.length) return '';
  return setCookieArray.map((c) => c.split(';')[0]).join('; ');
}

(async () => {
  try {
    let cookieHeader = '';

    if (password) {
      // Shopify's default storefront password form POSTs here with these exact field names.
      // maxRedirects: 0 + validateStatus: always-true so we can read the Set-Cookie header off the
      // 302 response ourselves — axios silently drops it if left to auto-follow the redirect.
      const passResp = await axios.post(
        `${base}/password`,
        new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          maxRedirects: 0,
          validateStatus: () => true,
          timeout: 20000,
        }
      );
      cookieHeader = toCookieHeader(passResp.headers['set-cookie']);
      if (!cookieHeader) {
        console.error(
          'Warning: no session cookie came back from /password — the password may be wrong, or ' +
            'this store might not actually be password-protected. Continuing without it.'
        );
      }
    }

    const resp = await axios.get(`${base}/collections.json`, {
      params: { limit: 250 },
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
      timeout: 20000,
      validateStatus: () => true,
    });

    if (resp.status !== 200 || !resp.data || !Array.isArray(resp.data.collections)) {
      console.error(
        `ERROR: unexpected response (status ${resp.status}) — this store may still be ` +
          'password-protected (wrong/missing password), collections.json may be disabled, or the ' +
          'domain is wrong.'
      );
      console.error(JSON.stringify(resp.data).slice(0, 500));
      process.exit(1);
    }

    const collections = resp.data.collections.map((c) => ({
      id: c.id,
      title: c.title,
      handle: c.handle,
    }));

    console.log(JSON.stringify(collections));
  } catch (err) {
    console.error('ERROR:', err.message);
    if (err.response) console.error('status:', err.response.status);
    process.exit(1);
  }
})();
