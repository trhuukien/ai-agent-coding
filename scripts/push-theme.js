#!/usr/bin/env node
// Pushes specific local theme files back to Shopify. Only pushes the exact keys you pass — never
// the whole theme — so a batch of apply-section.js/update-settings-current.js writes gets pushed
// as soon as that batch is validated, not bundled with unrelated later work.
//
// Usage:
//   node scripts/push-theme.js <store> <themeId> <fileKey> [fileKey ...]
//   e.g. node scripts/push-theme.js kizchann 190133404012 templates/index.json sections/header-group.json
require('dotenv').config({ quiet: true });
const { pushFiles, AuthRequiredError } = require('../src/shopify/cli');

const [, , storeArg, themeId, ...keys] = process.argv;

if (!storeArg || !themeId || keys.length === 0) {
  console.error('Usage: node scripts/push-theme.js <store> <themeId> <fileKey> [fileKey ...]');
  process.exit(1);
}

const store = storeArg.includes('.') ? storeArg : `${storeArg}.myshopify.com`;

pushFiles(store, themeId, keys)
  .then(() => console.log(`Pushed ${keys.length} file(s) to ${store}/${themeId}.`))
  .catch((err) => {
    if (err instanceof AuthRequiredError) {
      console.error(`Auth required — open ${err.authUrl} and enter code ${err.userCode}, then retry.`);
    } else {
      console.error('Push failed:', err.message);
    }
    process.exit(1);
  });
