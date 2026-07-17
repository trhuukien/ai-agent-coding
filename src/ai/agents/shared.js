const { listLocalFiles, readLocalFile, writeLocalFile, searchInTheme } = require('../../shopify/cli');
const { fetchPageElements } = require('../../shopify/fetch-html');
const { fetchFigmaNode, fetchFigmaNodes, fetchFigmaIconSvg } = require('../../figma/fetch-figma');
const { resolveSchemaTranslations } = require('../../shopify/locale-resolve');
const { upsertTemplateSection, readTemplateSection } = require('../../shopify/template-section');

// Files whose {% schema %} / settings JSON contains "t:..." translation keys —
// resolve them against locales/en.default.schema.json before handing the
// content to the model, so it reads real English labels instead of key paths
// it would otherwise have to guess the meaning of.
function needsTranslationResolve(key) {
  return key.endsWith('.liquid') || key === 'config/settings_schema.json';
}

const TOOLS = [
  {
    name: 'list_theme_files',
    description: 'List all files in the local theme. Use this first to understand the structure.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_theme_file',
    description: 'Read a theme file (Liquid, CSS, JS, JSON). Read before editing.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'File key e.g. "assets/custom.css", "sections/hero.liquid"' },
      },
      required: ['key'],
    },
  },
  {
    name: 'write_theme_file',
    description: 'Write/update a theme file locally. Changes will be pushed to Shopify after you finish.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'File key to write' },
        content: { type: 'string', description: 'Complete new file content' },
        reason: { type: 'string', description: 'What was changed and why' },
      },
      required: ['key', 'content', 'reason'],
    },
  },
  {
    name: 'search_in_theme',
    description: 'Search for a string or pattern across all local theme files. Returns file path, line number, and matched line.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern to search for' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'fetch_page_elements',
    description: 'Fetch a live storefront page and return a compact DOM tree with CSS classes and text. Use this before writing any CSS to find exact selectors.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Page path e.g. "/", "/collections/all", "/products/handle?preview_theme_id=xxx"' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_template_section',
    description: 'Read the CURRENT object for ONE section already in a template JSON file (e.g. "templates/index.json"), without reading or holding the rest of that file. Returns null if the template or section key doesn\'t exist yet. Call this BEFORE write_template_section whenever you are refining/adding to an ALREADY-CONFIGURED page (e.g. filling in "_mobile" settings for a section a prior desktop pass already set up) — so you know what already exists and can pass merge: true to update just what you mean to, instead of accidentally overwriting it.',
    input_schema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Template file key, e.g. "templates/index.json"' },
        section_key: { type: 'string', description: 'The section key to read, e.g. "slideshow_paper"' },
      },
      required: ['template', 'section_key'],
    },
  },
  {
    name: 'write_template_section',
    description: 'Write or update ONE section entry inside a template JSON file (e.g. "templates/index.json"), without needing to read or hold the rest of that file — the tool reads the current file itself, splices in just this one section under "sections", and updates its position in "order". Use this instead of write_theme_file when you are configuring a single page section; this way your context never has to carry the other sections already on the page. Every setting id/value is checked against that section\'s own real {% schema %} before writing; the write always goes through, but a "range" value off its valid step or outside min/max is auto-snapped to the nearest valid value, an invalid "select" value falls back to that field\'s own default, and an unknown/invented field id is dropped. It is ALSO cross-checked in code against every fetch_figma_node result already seen in this conversation: when a Figma frame has a solid background/button fill that unambiguously matches exactly one unset color field, that field is filled in for you automatically; a highlighted (mixedStyleRuns) text run not wrapped in [brackets], a Figma pagination counter ("1/5") implying more repeated blocks than you wrote, or an ambiguous fill/field pairing are reported as "Flagged" notes instead (these need your own judgment — the tool result explains exactly what and why). It also flags a built-in icon-select value (e.g. "delivery-truck") set on a field that has a paired empty "custom_icon" slot when fetch_figma_icon_svg was never called ANYWHERE this conversation — a strong signal the icon was guessed instead of exported; call fetch_figma_icon_svg for every icon the design shows a specific vector for before this write, not after. Read the tool result\'s notes every time; don\'t assume a clean write means nothing needs a second look.',
    input_schema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Template file key, e.g. "templates/index.json"' },
        section_key: { type: 'string', description: 'The key this section is/will be stored under in "sections" (snake_case, descriptive)' },
        section: {
          type: 'object',
          description: 'By default (merge: false), the COMPLETE section object: { "type": "...", "settings": {...}, "blocks": {...}, "block_order": [...] }. With merge: true, only include the type plus whichever settings/blocks you actually want to add or change — everything else already on the existing section is preserved untouched.',
        },
        merge: {
          type: 'boolean',
          description: 'Default false (full replace — use for a brand-new section, or a full section rewrite). Set true when refining/adding to a section that already exists (e.g. filling in mobile-only settings after a desktop pass already configured this section, or a static settings-schema/theme-config edit): settings/blocks you provide are shallow-merged key-by-key onto the CURRENT object (read it first with read_template_section if you want to see what you\'re merging onto) — anything you don\'t mention stays exactly as it was, including block_order (untouched unless you explicitly pass a non-empty one).',
        },
        position_after: {
          type: 'string',
          description: 'Optional. The section_key this section should be placed immediately after in "order". Pass "start" to place it first. Omit to leave it at the end (or where it already is, if updating an existing section).',
        },
        reason: { type: 'string', description: 'What was configured and why' },
      },
      required: ['template', 'section_key', 'section'],
    },
  },
  {
    name: 'fetch_figma_node',
    description: 'Fetch one or more Figma frames/nodes and return their real design data: exact text content, font family/size/weight, exact fill colors (hex), spacing/padding, corner radius, and layout bounding boxes. Use this whenever the task includes a Figma link, instead of estimating those values from a screenshot. IMPORTANT — Figma\'s API rate-limits by request COUNT, not by payload size, node count, or the depth parameter (Tier 1: 10-20 requests/minute depending on plan, or as low as 6/month on a Viewer/Collab seat). When you need several sibling nodes from the SAME Figma file (e.g. multiple sections on one page), pass them all via "urls" in ONE call instead of calling this tool once per node — this is Figma\'s own recommended way to avoid rate limits, and it does NOT cost extra since cost is per-request. Only use "url" for a single node. If a frame is large (many repeated component instances, e.g. a full color-swatch panel) pass a shallow "depth" to keep the response manageable for you to read — this reduces YOUR context cost, not Figma\'s rate-limit cost. depth is counted from each node you pass, not the file root. A TEXT node may include a "mixedStyleRuns" array when part of its own text is styled differently from the rest (e.g. one phrase in a different color/italic/weight) — this is a design "highlight" on that text; a node with no mixedStyleRuns is uniformly styled.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Figma file or frame URL for a single node, e.g. "https://www.figma.com/design/abc123/My-File?node-id=12-34". Use "urls" instead when fetching more than one node from the same file.' },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple Figma frame URLs from the SAME file (same file key), fetched together in a single Figma API request. Prefer this over separate fetch_figma_node calls whenever you need several sibling sections/nodes — it counts as only one request against Figma\'s rate limit. Results are returned in the same order as this list.',
        },
        depth: { type: 'integer', description: 'Optional. How many levels of children to fetch below each node. Omit for full depth; use a small number (e.g. 5-8) for large/repetitive frames to keep the response easier to read.' },
      },
      required: [],
    },
  },
  {
    name: 'fetch_figma_icon_svg',
    description: 'Export ONE Figma node (an icon/glyph — the vector, component instance, or frame that visually IS the icon, not its parent row/card) as real SVG markup. Use this whenever a section/block schema has a "Custom icon (SVG code)" field (or similarly-named raw-SVG/HTML icon field) and the Figma design shows a specific icon — paste the returned markup directly into that setting instead of guessing the closest-sounding name from the theme\'s built-in icon picker. The url must include a node-id for the specific icon node (found from a prior fetch_figma_node call\'s "id" field on that icon\'s own node, not a text label or its container). The returned markup is already normalized for you (in code, not something you need to edit yourself): its width/height are rewritten to "100%" so it scales to whatever box the section CSS gives it, and a style="fill: none;" is added so it inherits color from the section\'s own icon-color setting instead of carrying Figma\'s hardcoded fill — paste the result as-is.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Figma frame URL for the single icon node, e.g. "https://www.figma.com/design/abc123/My-File?node-id=12-34".' },
      },
      required: ['url'],
    },
  },
];

async function executeTool(name, input, store, themeId, storePassword, figmaCache, svgExportCount) {
  switch (name) {
    case 'list_theme_files':
      return JSON.stringify(listLocalFiles(store, themeId), null, 2);
    case 'read_theme_file': {
      const content = readLocalFile(store, themeId, input.key);
      if (content === null) return `File not found: ${input.key}`;
      if (!content) return '(empty file)';
      return needsTranslationResolve(input.key) ? resolveSchemaTranslations(content, store, themeId) : content;
    }
    case 'write_theme_file':
      writeLocalFile(store, themeId, input.key, input.content);
      return `Written: ${input.key}`;
    case 'read_template_section': {
      const section = readTemplateSection(store, themeId, input.template, input.section_key);
      return section ? JSON.stringify(section, null, 2) : `null (no section "${input.section_key}" in ${input.template} yet)`;
    }
    case 'write_template_section': {
      const result = upsertTemplateSection(
        store,
        themeId,
        input.template,
        input.section_key,
        input.section,
        input.position_after,
        input.merge || false,
        figmaCache,
        svgExportCount ? svgExportCount.count : 0
      );
      const correctionsMsg = result.notes.length
        ? `\nAuto-corrected / flagged before writing:\n${result.notes.map((n) => `  - ${n}`).join('\n')}`
        : '';
      return `Wrote section "${input.section_key}" into ${input.template}${input.merge ? ' (merged)' : ''}. Current order: ${JSON.stringify(result.order)}${correctionsMsg}`;
    }
    case 'search_in_theme':
      return JSON.stringify(searchInTheme(store, themeId, input.pattern), null, 2);
    case 'fetch_page_elements': {
      try {
        const elements = await fetchPageElements(store, input.path, storePassword || null);
        return JSON.stringify(elements, null, 2);
      } catch (err) {
        if (err.message === 'STORE_PASSWORD_REQUIRED') {
          return 'Error: Store is password-protected. A storePassword was not provided for this request.';
        }
        return `Error fetching page: ${err.message}`;
      }
    }
    case 'fetch_figma_node': {
      try {
        if (!input.url && !(input.urls && input.urls.length)) {
          return 'Error: provide either "url" (single node) or "urls" (multiple sibling nodes from the same file).';
        }
        const nodes = input.urls && input.urls.length
          ? await fetchFigmaNodes(input.urls, process.env.FIGMA_ACCESS_TOKEN, input.depth ?? null)
          : await fetchFigmaNode(input.url, process.env.FIGMA_ACCESS_TOKEN, input.depth ?? null);
        // Cached so a later write_template_section in this same conversation can be cross-checked
        // in code against the actual design data, without the model having to re-paste it.
        if (figmaCache) figmaCache.push(...nodes.filter(Boolean));
        return JSON.stringify(nodes, null, 2);
      } catch (err) {
        if (err.message === 'FIGMA_TOKEN_REQUIRED') {
          return 'Error: FIGMA_ACCESS_TOKEN is not configured on the server (.env). Ask the operator to add it, or continue from the screenshot only.';
        }
        if (err.response?.status === 401 || err.response?.status === 403) {
          return 'Error: Figma rejected the access token (invalid, expired, or lacks permission on this file).';
        }
        if (err.response?.status === 404) {
          return 'Error: Figma file/node not found — double check the URL.';
        }
        if (err.response?.status === 429) {
          const retryAfter = err.response.headers?.['retry-after'];
          return `Error: Figma rate limit hit${retryAfter ? ` — retry after ${retryAfter}s` : ''}. Batch remaining nodes into fewer fetch_figma_node calls using "urls".`;
        }
        return `Error fetching Figma node: ${err.message}`;
      }
    }
    case 'fetch_figma_icon_svg': {
      try {
        const svg = await fetchFigmaIconSvg(input.url, process.env.FIGMA_ACCESS_TOKEN);
        // Counted (not the SVG content itself — nothing downstream needs it) so write_template_section
        // can tell whether ANY real icon was exported this conversation before a guessed built-in icon
        // gets flagged as suspicious.
        if (svgExportCount) svgExportCount.count += 1;
        return svg;
      } catch (err) {
        if (err.message === 'FIGMA_TOKEN_REQUIRED') {
          return 'Error: FIGMA_ACCESS_TOKEN is not configured on the server (.env). Ask the operator to add it, or fall back to the closest built-in icon.';
        }
        if (err.response?.status === 401 || err.response?.status === 403) {
          return 'Error: Figma rejected the access token (invalid, expired, or lacks permission on this file).';
        }
        if (err.response?.status === 404) {
          return 'Error: Figma file/node not found — double check the URL and node-id.';
        }
        if (err.response?.status === 429) {
          const retryAfter = err.response.headers?.['retry-after'];
          return `Error: Figma rate limit hit${retryAfter ? ` — retry after ${retryAfter}s` : ''}.`;
        }
        return `Error exporting Figma icon as SVG: ${err.message}`;
      }
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function runAgentLoop(anthropic, systemPrompt, messages, store, themeId, storePassword, onProgress) {
  const changedFiles = [];
  // Scoped to this one section's conversation (each page section runs its own short-lived
  // runAgentLoop call) — every fetch_figma_node result in this conversation is cached here so a
  // later write_template_section can be cross-checked in code (audit-section.js) against the real
  // design data, automatically, with no extra tool call or prompt reliance.
  const figmaCache = [];
  // Same per-conversation scoping as figmaCache — counts real fetch_figma_icon_svg calls so
  // write_template_section can flag a guessed built-in icon when NO real export was ever attempted.
  const svgExportCount = { count: 0 };

  for (let i = 0; i < 20; i++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (onProgress) {
      const textBlocks = response.content.filter((b) => b.type === 'text').map((b) => b.text);
      const toolCalls = response.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => `[tool] ${b.name}${b.input.key ? ` → ${b.input.key}` : ''}`);
      const msg = [...textBlocks, ...toolCalls].filter(Boolean).join('\n');
      if (msg) onProgress(msg);
    }

    if (response.stop_reason === 'end_turn') {
      const summary = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      return { changedFiles, summary };
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        let result;
        try {
          result = await executeTool(block.name, block.input, store, themeId, storePassword, figmaCache, svgExportCount);
          if (block.name === 'write_theme_file') {
            changedFiles.push({ key: block.input.key, reason: block.input.reason });
            console.log(`  ✎ wrote ${block.input.key}`);
          } else if (block.name === 'write_template_section') {
            changedFiles.push({ key: block.input.template, reason: block.input.reason || `configured section "${block.input.section_key}"` });
            console.log(`  ✎ wrote section "${block.input.section_key}" → ${block.input.template}`);
          }
        } catch (err) {
          result = `Error: ${err.message}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }

  throw new Error('Agent exceeded max iterations');
}

module.exports = { TOOLS, executeTool, runAgentLoop };
