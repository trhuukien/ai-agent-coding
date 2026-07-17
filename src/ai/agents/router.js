/**
 * Router agent — classifies a task to one of the workflow agents.
 * Returns: { workflow: 'A'|'B'|'C'|'D'|'E', reason: string }
 */

const ROUTER_PROMPT = `You are a task classifier for a Shopify theme AI agent.
Given a customer request, return ONLY a JSON object (no explanation) in this format:
{ "workflow": "<letter>", "reason": "<one sentence>" }

Workflow options:
- A: Section-scoped CSS — style change targeting a specific section on a specific page (e.g. "make the hero text white on the homepage slideshow")
- B: Global CSS — style change affecting multiple pages or global elements like header/footer/nav
- C: Liquid template change — any change to HTML markup, text content, URLs, logic, or translation strings in .liquid files
- D: Theme config — change a global theme setting (color, font, layout, feature toggle) that lives in settings_data.json
- E: Page/section configuration from a design image or Figma link — build or reconfigure page
  section(s) to match a provided image and/or a figma.com URL in the task text, optionally with a
  list naming which section type to use per visual block (e.g. "config homepage: section 1:
  slideshow, section 2: scroll promotion, section 3: richtext..."). Always requires an image or a
  Figma link.

When in doubt between A and B: choose A if the user mentions a specific page or section; choose B otherwise.
When in doubt between C and D: choose C if it involves markup/text/URL; choose D if it's a setting toggle or value.
When in doubt between C and E: choose E only if an image/Figma link was provided and the request is about matching a section's content/layout to it; choose C for text-only edits with no image or Figma link.`;

async function classifyTask(anthropic, task, images = []) {
  const content = [];

  if (images && images.length > 0) {
    for (const img of images) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      });
    }
  }

  content.push({ type: 'text', text: `Task: ${task}` });

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: ROUTER_PROMPT,
    messages: [{ role: 'user', content }],
  });

  const text = response.content.find((b) => b.type === 'text')?.text || '';

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (_) {}

  // Fallback: guess from keywords
  const lower = task.toLowerCase();
  const hasFigmaLink = /figma\.com\//i.test(task);
  const hasNumberedSectionList = /section\s*\d+\s*[:.]/i.test(task);
  if (hasFigmaLink && hasNumberedSectionList) {
    return { workflow: 'E', reason: 'Keyword match: image/Figma link with a numbered per-section list' };
  }
  if (hasFigmaLink) {
    return { workflow: 'E', reason: 'Keyword match: task contains a Figma link' };
  }
  if (lower.includes('css') || lower.includes('style') || lower.includes('color') || lower.includes('font') || lower.includes('margin') || lower.includes('padding')) {
    return { workflow: 'B', reason: 'Keyword match: CSS/style change' };
  }
  if (lower.includes('text') || lower.includes('url') || lower.includes('link') || lower.includes('button') || lower.includes('liquid')) {
    return { workflow: 'C', reason: 'Keyword match: Liquid/text change' };
  }
  if (lower.includes('setting') || lower.includes('config') || lower.includes('theme') || lower.includes('font')) {
    return { workflow: 'D', reason: 'Keyword match: theme config' };
  }
  return { workflow: 'C', reason: 'Default fallback' };
}

module.exports = { classifyTask };
