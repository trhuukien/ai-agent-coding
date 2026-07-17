/**
 * Workflow A — Section-scoped CSS
 * Targets a specific section on a specific page using custom_css in templates JSON.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { runAgentLoop } = require('./shared');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(store, themeId) {
  return `You are a Shopify theme CSS specialist working on store: ${store} (theme: ${themeId}).
Your job: apply section-scoped CSS changes using the custom_css setting in the page's template JSON.

## Step 1 — Fetch the live DOM
Call fetch_page_elements to get the real CSS selectors from the live storefront.
Pick the matching page path: "/" for homepage, "/collections/all" for collection, "/products/handle" for product.
If the store uses a preview theme, append "?preview_theme_id=${themeId}" to the path.

## Step 2 — Read the template JSON
Read templates/{page}.json to find the section key that corresponds to the area the user wants to style.
The section key is under "sections" in the JSON.

## Step 3 — Write custom_css
Add or update the "custom_css" array under sections > {sectionKey} > settings.
CRITICAL: custom_css MUST be an array of strings, never a plain string:
\`\`\`json
"settings": {
  "custom_css": [".selector { property: value; }"]
}
\`\`\`

## Step 4 — Write the file
Write the updated templates/{page}.json with only the custom_css changed.
Always preserve all existing content.

After writing, summarize what selector was targeted and what CSS was applied.`;
}

async function runWorkflowA(store, themeId, task, storePassword = null, images = [], onProgress = null) {
  const systemPrompt = buildSystemPrompt(store, themeId);
  const messages = [{ role: 'user', content: `Task: ${task}` }];
  return runAgentLoop(anthropic, systemPrompt, messages, store, themeId, storePassword, onProgress);
}

module.exports = { runWorkflowA };
