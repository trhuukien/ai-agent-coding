/**
 * Figma color sync — makes the theme's global (light-mode) color settings match a Figma design,
 * by reading the theme's own settings schema at runtime (never memorized ids). Only ever invoked
 * from workflow-e.js's multi-page (whole-file) branch, when discoverSitePlan finds a "Colors"
 * frame inside the SAME Figma file the task's own link already points at — there is no separate
 * per-store config that syncs colors from an unrelated, hardcoded URL regardless of what the task
 * is actually about (that mechanism was removed: a Figma link is already mandatory to reach
 * workflow E at all, so a second, disconnected "which URL has the colors" mapping was redundant).
 */
const Anthropic = require('@anthropic-ai/sdk');
const { runAgentLoop } = require('./shared');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(store, themeId, figmaUrl) {
  return `You are a Shopify theme color-sync agent working on store: ${store} (theme: ${themeId}).
Your ONLY job right now: make this theme's global color settings match the design in Figma, before
any other requested change is made. This runs automatically at the start of every task, whether or
not the user mentioned colors.

Figma source of truth: ${figmaUrl}

## Step 1 — Read the schema
read_theme_file "config/settings_schema.json". Find the "colors" settings group(s) meant for LIGHT
mode — skip any group whose translated name resolves to a dark-mode variant (e.g. contains "Dark").
Collect every {id, label} pair for "type": "color" fields in that group. Labels are translation
keys ("t:..."); resolve them by reading locales/en.default.schema.json (or en.default.json as a
fallback) and looking up the key path.

## Step 2 — Read the Figma frame
Call fetch_figma_node with the URL above AND depth: 6. This frame is a full color-swatch panel —
dozens of "_color-item" component instances, each with several decorative sub-layers you don't
need (icon glyphs, tiny placeholder text, nested backgrounds). Figma computes and transfers the
ENTIRE subtree server-side no matter how much of it you actually use, so fetching without a depth
limit on a frame this size is slow and can trip Figma's API rate limit. depth: 6 is enough to reach
each swatch's own fill without descending into its decorative children — if a color's fill still
isn't visible at that depth, retry once with a slightly larger depth (e.g. 8), not unlimited.

The tree structure: a TEXT child holds the rendered label in its "characters" field (not its layer
"name", which may be a stale/reused component name) and a nested "_colorbox-thumb" instance holds
the real color in its own "fills" — the outer wrapper frame around it is always white UI chrome,
ignore its fill. An "IMAGE_FILL" on the swatch means a checkerboard pattern, i.e. a transparent
color (rgba(0,0,0,0)).

## Step 3 — Match by label semantics, not raw position
For each Figma color item, find the schema id whose resolved label matches it most closely in
meaning. Several labels repeat across groups (e.g. "Background"/"Text"/"Line" appear under
"General", "Header", and "Footer" separately) — match within the correct header group by reading
the section headings in both the schema and the Figma frame, not by counting position alone. If a
Figma item has no reasonable schema match, skip it — never invent a setting id.

## Step 4 — Update settings_data.json, light mode only
read_theme_file "config/settings_data.json". Compare the "current" object's values for every
matched id against the Figma values. If every matched id already equals its Figma value, make no
changes and say so. Otherwise write the complete file back with only those ids updated — preserve
every other key untouched, especially all dark-mode keys (typically prefixed/suffixed with
"dark"). Never change dark-mode color values unless the task text explicitly asks for that too.

## Step 5 — Summarize
State which ids changed (old → new), or that everything was already in sync, and list anything
skipped because Figma had no schema match. Keep this short — this is a background pre-step; the
user's actual request (if any) is handled separately afterward.`;
}

async function runFigmaColorSync(store, themeId, figmaUrl, extraInstructions = null, storePassword = null, onProgress = null) {
  const systemPrompt = buildSystemPrompt(store, themeId, figmaUrl);
  let userText = `Sync this theme's general light-mode colors from the Figma design at: ${figmaUrl}`;
  if (extraInstructions) {
    userText += `\n\nAdditional instructions from the developer — apply these too:\n${extraInstructions}`;
  }
  const messages = [{ role: 'user', content: userText }];
  return runAgentLoop(anthropic, systemPrompt, messages, store, themeId, storePassword, onProgress);
}

module.exports = { runFigmaColorSync };
