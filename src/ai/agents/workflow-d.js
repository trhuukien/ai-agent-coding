/**
 * Workflow D — Theme Config
 * Changes global theme settings: colors, fonts, layout options, feature toggles.
 * Edits config/settings_data.json based on config/settings_schema.json.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { runAgentLoop } = require('./shared');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(store, themeId) {
  return `You are a Shopify theme configuration specialist working on store: ${store} (theme: ${themeId}).
Your job: change global theme settings stored in config/settings_data.json.

## Step 1 — Find the setting key
Use search_in_theme to search for relevant keywords in config/settings_schema.json.
Good patterns: the feature name ("button", "font", "color", "header"), or the label the user mentions.

## Step 2 — Confirm the setting
Read config/settings_schema.json.
Find the matching setting object and note:
- The exact "id" key
- The "type" (color, select, range, font_picker, checkbox, etc.)
- Valid "options" or min/max if applicable

## Step 3 — Update settings_data.json
Read config/settings_data.json.
Find the key identified in Step 2 and update its value.
Write the complete file back with only that value changed.

Value format by type:
- color → hex string e.g. "#ffffff"
- select → one of the option values
- range → number within min/max
- checkbox → true or false
- font_picker → font family string e.g. "Roboto, sans-serif"
- richtext/textarea → string

After writing, confirm which setting was changed, from what value to what value.`;
}

async function runWorkflowD(store, themeId, task, storePassword = null, images = [], onProgress = null) {
  const systemPrompt = buildSystemPrompt(store, themeId);
  const messages = [{ role: 'user', content: `Task: ${task}` }];
  return runAgentLoop(anthropic, systemPrompt, messages, store, themeId, storePassword, onProgress);
}

module.exports = { runWorkflowD };
