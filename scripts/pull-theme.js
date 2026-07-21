#!/usr/bin/env node
// Pulls a theme from Shopify into theme/<store-handle>/<themeId>/ (store-handle = the bare
// handle, ".myshopify.com" stripped — see toHandle() in src/shopify/cli.js). <store> may be
// passed either as the bare handle or the full "<handle>.myshopify.com" domain; the real
// `shopify theme pull --store` call always needs the full domain, so a bare handle passed here
// gets ".myshopify.com" appended before the CLI call (only the local folder uses the bare form).
//
// Usage:
//   node scripts/pull-theme.js <store> <themeId>
require('dotenv').config({ quiet: true });
const { pullTheme, AuthRequiredError } = require('../src/shopify/cli');

const [, , storeArg, themeId] = process.argv;

if (!storeArg || !themeId) {
  console.error('Usage: node scripts/pull-theme.js <store> <themeId>');
  process.exit(1);
}

const store = storeArg.includes('.') ? storeArg : `${storeArg}.myshopify.com`;

pullTheme(store, themeId).catch((err) => {
  if (err instanceof AuthRequiredError) {
    console.error(`Auth required — open ${err.authUrl} and enter code ${err.userCode}, then retry.`);
  } else {
    console.error('Pull failed:', err.message);
  }
  process.exit(1);
});
