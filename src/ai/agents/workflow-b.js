/**
 * Workflow B — Global CSS
 * Applies CSS that affects multiple pages or global elements (header, footer, nav).
 * Uses snippets/custom-global-styles.liquid injected into layout/theme.liquid.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { runAgentLoop } = require('./shared');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(store, themeId) {
  return `You are a Shopify theme CSS specialist working on store: ${store} (theme: ${themeId}).
Your job: apply global CSS changes that affect multiple pages or global elements like navigation/header/footer.

## Step 1 — Fetch the live DOM
Call fetch_page_elements to get the real CSS selectors.
Use "/" for global/header/footer changes, or the specific page path if the change is page-specific.
If the store uses a preview theme, append "?preview_theme_id=${themeId}" to the path.

## Step 2 — Check if global style snippet exists
Call read_theme_file: snippets/custom-global-styles.liquid

## Step 3a — If snippet does NOT exist (file not found):
1. Create snippets/custom-global-styles.liquid:
\`\`\`liquid
<style>
  /* CSS here */
</style>
\`\`\`
2. Read layout/theme.liquid
3. Find the </head> closing tag
4. Insert {%- render 'custom-global-styles' -%} on the line just before </head>
5. Write the updated layout/theme.liquid

## Step 3b — If snippet already exists:
Read it, add the new CSS rules inside the existing <style> tag, write it back.
Do NOT touch layout/theme.liquid again.

After writing, summarize what global CSS was added and what selectors it targets.`;
}

async function runWorkflowB(store, themeId, task, storePassword = null, images = [], onProgress = null) {
  const systemPrompt = buildSystemPrompt(store, themeId);
  const messages = [{ role: 'user', content: `Task: ${task}` }];
  return runAgentLoop(anthropic, systemPrompt, messages, store, themeId, storePassword, onProgress);
}

module.exports = { runWorkflowB };
