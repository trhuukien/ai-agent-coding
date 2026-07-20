#!/usr/bin/env node
// Reads ONLY the theme's effective "current" (light-mode) settings object from
// config/settings_data.json — never the full file, which also carries N full preset objects
// (each nearly as large as "current" itself) that a general-config pass never needs to see.
//
// Shopify's own settings_data.json format allows "current" to be EITHER a full settings object
// (once a merchant has customized anything via the theme editor) OR just a plain string naming
// which preset is active (the untouched-since-install state — Shopify hasn't "promoted" it to a
// real object yet). This script resolves BOTH cases to the same real settings object so the
// caller never has to special-case it.
//
// Usage:
//   node scripts/read-settings-current.js <store> <themeId>
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { getThemeDir } = require('../src/shopify/cli');

const [, , store, themeId] = process.argv;

if (!store || !themeId) {
  console.error('Usage: node scripts/read-settings-current.js <store> <themeId>');
  process.exit(1);
}

const filePath = path.join(getThemeDir(store, themeId), 'config/settings_data.json');
const raw = fs.readFileSync(filePath, 'utf8').replace(/^\/\*[\s\S]*?\*\//, '');
const data = JSON.parse(raw);

const current = typeof data.current === 'string' ? data.presets?.[data.current] || {} : data.current || {};

console.log(JSON.stringify(current));
