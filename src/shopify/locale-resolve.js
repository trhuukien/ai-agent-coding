// Shopify section/theme schemas reference labels as translation keys
// ("t:sections.multicolumn.settings.line_border.options__2.label") instead of
// real text. The AI has no way to know what a key like that says without
// reading it — and must never guess/translate it itself. The real text
// already exists, verbatim, in locales/en.default.schema.json (same dot path
// with the leading "t:" stripped), so resolving it is pure lookup, not
// translation.
const fs = require('fs');
const path = require('path');
const { getThemeDir } = require('./cli');

function stripJsonComments(text) {
  return text.replace(/^\/\*[\s\S]*?\*\//, '');
}

function loadLocaleMap(store, themeId) {
  const localePath = path.join(getThemeDir(store, themeId), 'locales', 'en.default.schema.json');
  if (!fs.existsSync(localePath)) return null;
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(localePath, 'utf8')));
  } catch {
    return null;
  }
}

function resolveKey(map, key) {
  const segments = key.replace(/^t:/, '').split('.');
  let node = map;
  for (const segment of segments) {
    if (node == null || typeof node !== 'object') return null;
    node = node[segment];
  }
  return typeof node === 'string' ? node : null;
}

// Replaces every "t:...." string literal in the given file content with its
// resolved English text, in place. A key with no match in the locale file is
// left as-is (raw "t:..." key) rather than silently dropped, so a missing
// translation stays visible instead of looking like a resolved empty string.
function resolveSchemaTranslations(content, store, themeId) {
  const map = loadLocaleMap(store, themeId);
  if (!map) return content;
  return content.replace(/"(t:[a-zA-Z0-9_.-]+)"/g, (match, key) => {
    const resolved = resolveKey(map, key);
    return resolved != null ? JSON.stringify(resolved) : match;
  });
}

module.exports = { resolveSchemaTranslations, loadLocaleMap, resolveKey };
