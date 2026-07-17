#!/usr/bin/env node
// Patches specific keys onto the theme's "current" (light-mode) settings in
// config/settings_data.json — reads/writes the file on disk as normal (has to, to preserve every
// preset and every other untouched key), but only ever prints a compact old->new diff to stdout,
// never the whole file — the caller should never need to hold the full presets blob in context
// just to change a handful of color/font values.
//
// Handles Shopify's "current is just a preset-name string" case automatically: if "current" hasn't
// been promoted to a real object yet (untouched-since-install theme), this clones the referenced
// preset's own settings into a real object first — same promotion Shopify itself does the first
// time a merchant changes anything in the theme editor — then applies the patch on top of that.
//
// Usage:
//   node scripts/update-settings-current.js <store> <themeId> <patchJsonFile>
//   patchJsonFile: a JSON object of { "setting_id": newValue, ... } — ONLY the keys you want
//   changed, never the full settings object. Never touch "_dark"-suffixed keys unless the task
//   explicitly asks for a dark-mode change.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { getThemeDir } = require('../src/shopify/cli');

const [, , store, themeId, patchFile] = process.argv;

if (!store || !themeId || !patchFile) {
  console.error('Usage: node scripts/update-settings-current.js <store> <themeId> <patchJsonFile>');
  process.exit(1);
}

const filePath = path.join(getThemeDir(store, themeId), 'config/settings_data.json');
const raw = fs.readFileSync(filePath, 'utf8');
const commentMatch = raw.match(/^\/\*[\s\S]*?\*\//);
const header = commentMatch ? commentMatch[0] + '\n' : '';
const jsonText = commentMatch ? raw.slice(commentMatch[0].length) : raw;
const data = JSON.parse(jsonText);

// Promote a bare preset-name string to a real object first, same as Shopify's own theme editor
// does the first time anything is customized — never patch keys onto the string itself.
if (typeof data.current === 'string') {
  const presetName = data.current;
  data.current = { ...(data.presets?.[presetName] || {}) };
}

const patch = JSON.parse(fs.readFileSync(patchFile, 'utf8'));
const diffs = [];
for (const [key, newValue] of Object.entries(patch)) {
  const oldValue = data.current[key];
  if (oldValue === newValue) continue;
  data.current[key] = newValue;
  diffs.push(`${key}: ${JSON.stringify(oldValue)} -> ${JSON.stringify(newValue)}`);
}

fs.writeFileSync(filePath, header + JSON.stringify(data, null, 2) + '\n', 'utf8');

if (diffs.length === 0) {
  console.log('No changes — every requested key already matched its current value.');
} else {
  console.log(`Updated ${diffs.length} key(s):`);
  diffs.forEach((d) => console.log(' - ' + d));
}
