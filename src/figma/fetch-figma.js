const axios = require('axios');

function parseFigmaUrl(url) {
  const fileMatch = url.match(/figma\.com\/(?:file|design|proto)\/([a-zA-Z0-9]+)/);
  if (!fileMatch) throw new Error('Not a valid Figma file URL');
  const fileKey = fileMatch[1];

  const nodeMatch = url.match(/node-id=([^&]+)/);
  const nodeId = nodeMatch ? decodeURIComponent(nodeMatch[1]).replace(/-/g, ':') : null;

  return { fileKey, nodeId };
}

function colorToHex(color, extraOpacity = 1) {
  const alpha = (color.a != null ? color.a : 1) * extraOpacity;
  const toByte = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  const hex = `#${toByte(color.r)}${toByte(color.g)}${toByte(color.b)}`;
  return alpha < 1 ? `${hex}${toByte(alpha)}` : hex;
}

function summarizePaints(paints) {
  if (!paints || !paints.length) return null;
  const visible = paints.filter((p) => p.visible !== false);
  if (!visible.length) return null;
  return visible.map((p) => {
    if (p.type === 'SOLID') return colorToHex(p.color, p.opacity != null ? p.opacity : 1);
    if (p.type === 'IMAGE') return 'IMAGE_FILL';
    return p.type;
  });
}

// Figma text nodes can style individual character ranges differently from the node's own
// base style (e.g. a highlighted word in a different color/italic/weight) via
// characterStyleOverrides (one style-table index per character, 0 = base style) +
// styleOverrideTable (index -> partial style object). The plain `node.fills`/`node.style`
// read elsewhere only ever reflects the base style, so a mixed-style run is otherwise
// invisible in the summarized output — this is what a design calls a "highlight" on a
// heading. Only returns something when there are at least 2 distinct runs.
function extractMixedStyleRuns(node) {
  const overrides = node.characterStyleOverrides;
  const table = node.styleOverrideTable;
  const chars = node.characters;
  if (!overrides || !table || !chars || !overrides.some((v) => v !== 0)) return null;

  const runs = [];
  let runStart = 0;
  let runStyle = overrides[0] || 0;
  for (let i = 1; i <= overrides.length; i++) {
    const styleAtI = i < overrides.length ? overrides[i] || 0 : null;
    if (styleAtI !== runStyle) {
      runs.push({ start: runStart, end: i, styleId: runStyle });
      runStart = i;
      runStyle = styleAtI;
    }
  }
  if (runs.length < 2) return null;

  return runs.map((r) => {
    const run = { text: chars.slice(r.start, r.end) };
    const styleOverride = r.styleId ? table[r.styleId] : null;
    if (styleOverride) {
      if (styleOverride.fontFamily) run.fontFamily = styleOverride.fontFamily;
      if (styleOverride.fontWeight != null) run.fontWeight = styleOverride.fontWeight;
      if (styleOverride.italic) run.italic = true;
      const color = summarizePaints(styleOverride.fills);
      if (color) run.color = color;
    }
    return run;
  });
}

// Depth cap avoids runaway recursion on pathological files; child-count cap keeps
// decorative vector icon trees (which can have hundreds of sub-paths) from
// blowing up the payload handed back to the model.
const MAX_DEPTH = 12;
const MAX_CHILDREN = 40;

// Figma auto-layout files are full of single-purpose wrapper frames (an
// "Instance" wrapping a "Frame" wrapping another "Frame" that finally holds
// the one TEXT node with real content) — these carry no visual information of
// their own (no fill/stroke/corner-radius/opacity) and sit at the exact same
// box as their one child, so unwrapping them loses nothing but cuts several
// levels of pure naming noise ("Base-title", "Frame 1000004697", ...) out of
// every node the model has to read.
function isPassthroughWrapper(out) {
  if (!out.children || out.children.length !== 1) return false;
  if (out.fills || out.strokes || out.cornerRadius != null || out.opacity != null) return false;
  const child = out.children[0];
  if (!out.box || !child.box) return false;
  return (
    out.box.x === child.box.x &&
    out.box.y === child.box.y &&
    out.box.width === child.box.width &&
    out.box.height === child.box.height
  );
}

// A subtree is "purely decorative" when nothing inside it is a TEXT node or a
// real photo (IMAGE_FILL) — that's always just icon/vector artwork (arrow
// glyphs, star ratings, badge icons). Figma vector icons are frequently built
// from a dozen nested VECTOR/GROUP paths, none of which the model needs since
// there is no icon-path setting in any Shopify section schema — the model can
// only ever pick a named icon option (e.g. "leaf", "star") or skip it. Keeping
// the box/fill/stroke of the outer node is enough to describe size/color;
// the nested path geometry is pure noise.
function hasRealContent(out) {
  if (out.type === 'TEXT') return true;
  if (out.fills && out.fills.includes('IMAGE_FILL')) return true;
  // A "_colorbox-thumb"/"swatch"-named node IS its own content — a color-sync pass reads exactly
  // this node's own solid `fills` as the real design value, so it must never be pruned away just
  // because it has no TEXT/IMAGE inside it (a plain color swatch never does).
  if (out.name && /colorbox|swatch/i.test(out.name) && out.fills) return true;
  if (out.children) return out.children.some(hasRealContent);
  return false;
}

const CONTAINER_TYPES = new Set(['FRAME', 'GROUP', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET']);

function summarizeNode(node, depth = 0) {
  if (!node || depth > MAX_DEPTH) return null;
  if (depth > 0 && node.visible === false) return null;

  const out = { id: node.id, name: node.name, type: node.type };

  if (node.absoluteBoundingBox) {
    const { x, y, width, height } = node.absoluteBoundingBox;
    out.box = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }

  if (node.type === 'TEXT') {
    out.characters = node.characters;
    const style = node.style || {};
    out.font = {
      family: style.fontFamily,
      weight: style.fontWeight,
      size: style.fontSize,
      lineHeightPx: style.lineHeightPx,
      letterSpacing: style.letterSpacing,
      align: style.textAlignHorizontal,
    };
    const color = summarizePaints(node.fills);
    if (color) out.color = color;
    const mixedStyleRuns = extractMixedStyleRuns(node);
    if (mixedStyleRuns) out.mixedStyleRuns = mixedStyleRuns;
  } else if (node.fills) {
    const fills = summarizePaints(node.fills);
    if (fills) out.fills = fills;
  }

  if (node.strokes && node.strokes.length) {
    out.strokes = summarizePaints(node.strokes);
    if (node.strokeWeight != null) out.strokeWeight = node.strokeWeight;
  }

  if (node.cornerRadius != null) out.cornerRadius = node.cornerRadius;
  if (node.layoutMode && node.layoutMode !== 'NONE') out.layoutMode = node.layoutMode;
  if (node.itemSpacing != null) out.itemSpacing = node.itemSpacing;
  if (node.paddingLeft != null) {
    out.padding = {
      left: node.paddingLeft,
      right: node.paddingRight,
      top: node.paddingTop,
      bottom: node.paddingBottom,
    };
  }
  if (node.opacity != null && node.opacity !== 1) out.opacity = node.opacity;

  if (node.children && node.children.length) {
    const visibleChildren = node.children.filter((child) => child.visible !== false);
    const children = visibleChildren
      .slice(0, MAX_CHILDREN)
      .map((child) => summarizeNode(child, depth + 1))
      .filter(Boolean);
    if (children.length) out.children = children;
    if (visibleChildren.length > MAX_CHILDREN) {
      out.truncatedChildren = visibleChildren.length - MAX_CHILDREN;
    }
  }

  // Prune purely-decorative icon/vector subtrees (no TEXT, no real photo
  // anywhere inside) down to a flat stub — the nested vector path geometry is
  // never actionable (no section schema exposes raw icon paths).
  if (depth > 0 && CONTAINER_TYPES.has(out.type) && out.children && !hasRealContent(out)) {
    delete out.children;
    delete out.truncatedChildren;
    out.decorative = true;
  }

  // Unwrap pure pass-through wrappers bottom-up so a whole chain of them
  // (wrapper > wrapper > wrapper > TEXT) collapses down to just the TEXT node.
  if (isPassthroughWrapper(out)) return out.children[0];

  return out;
}

// Figma's REST API rate-limits GET file/nodes by request COUNT, not by payload size, node
// count, or the depth parameter (see https://developers.figma.com/docs/rest-api/rate-limits/ —
// Tier 1). Figma's own guidance is to batch multiple node ids into one request instead of
// calling once per node. fetchFigmaNodes does that: pass several sibling-node URLs from the
// SAME file and they're fetched in a single API call.
async function fetchFigmaNodes(urls, accessToken, depth = null) {
  if (!accessToken) {
    const err = new Error('FIGMA_TOKEN_REQUIRED');
    throw err;
  }
  if (!urls || !urls.length) return [];

  const parsed = urls.map(parseFigmaUrl);
  const fileKey = parsed[0].fileKey;
  if (parsed.some((p) => p.fileKey !== fileKey)) {
    throw new Error('All urls passed to fetchFigmaNodes must belong to the same Figma file');
  }
  const nodeIds = parsed.map((p) => p.nodeId);
  if (nodeIds.some((id) => !id)) {
    throw new Error('Every url passed to fetchFigmaNodes must include a node-id');
  }

  const depthParam = depth != null ? `&depth=${encodeURIComponent(depth)}` : '';
  const endpoint = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeIds.join(','))}${depthParam}`;

  const resp = await axios.get(endpoint, {
    headers: { 'X-Figma-Token': accessToken },
    timeout: 20000,
  });

  const nodesObj = resp.data.nodes || {};
  // Map back by the requested ids (in the caller's order) rather than trusting object key
  // order, since Figma echoes ids back in its own colon form regardless of input dash form.
  return nodeIds.map((id) => {
    const entry = nodesObj[id];
    return entry && entry.document ? summarizeNode(entry.document) : null;
  });
}

async function fetchFigmaNode(url, accessToken, depth = null) {
  if (!accessToken) {
    const err = new Error('FIGMA_TOKEN_REQUIRED');
    throw err;
  }

  const { fileKey, nodeId } = parseFigmaUrl(url);
  if (nodeId) {
    return fetchFigmaNodes([url], accessToken, depth);
  }

  // Whole-file fetch (no node-id in the URL) — no batching applies here.
  const depthParam = depth != null ? `?depth=${encodeURIComponent(depth)}` : '';
  const endpoint = `https://api.figma.com/v1/files/${fileKey}${depthParam}`;

  const resp = await axios.get(endpoint, {
    headers: { 'X-Figma-Token': accessToken },
    timeout: 20000,
  });

  const rootNodes = resp.data.document ? [resp.data.document] : [];
  return rootNodes.map((n) => summarizeNode(n));
}

// Figma exports an icon's own fixed pixel box (e.g. width="40" height="40") and often bakes in
// whatever fill color the source vector happened to have — neither is what a theme's "Custom icon"
// field wants: the icon needs to scale to whatever box the section CSS gives it (100%/100%) and
// inherit color from the surrounding text/icon color setting rather than carrying a hardcoded fill.
// This is applied unconditionally in code (not left to per-call judgment) so every icon pulled
// through fetchFigmaIconSvg is normalized the same way regardless of which agent/run requested it.
function normalizeIconSvg(svgText) {
  const openTagMatch = svgText.match(/<svg\b[^>]*>/i);
  if (!openTagMatch) return svgText;
  let openTag = openTagMatch[0];

  openTag = /\bwidth\s*=\s*"[^"]*"/i.test(openTag)
    ? openTag.replace(/\bwidth\s*=\s*"[^"]*"/i, 'width="100%"')
    : openTag.replace(/^<svg\b/i, '<svg width="100%"');
  openTag = /\bheight\s*=\s*"[^"]*"/i.test(openTag)
    ? openTag.replace(/\bheight\s*=\s*"[^"]*"/i, 'height="100%"')
    : openTag.replace(/^<svg\b/i, '<svg height="100%"');

  openTag = /\bstyle\s*=\s*"[^"]*"/i.test(openTag)
    ? openTag.replace(/\bstyle\s*=\s*"([^"]*)"/i, (_, existing) => `style="fill: none;${existing ? ` ${existing}` : ''}"`)
    : openTag.replace(/^<svg\b/i, '<svg style="fill: none;"');

  return svgText.slice(0, openTagMatch.index) + openTag + svgText.slice(openTagMatch.index + openTagMatch[0].length);
}

// Exports a node as real vector SVG markup via Figma's Images API — for icon/glyph nodes that a
// theme section lets you paste raw SVG into (a "Custom icon (SVG code)" field), this is the ground
// truth: don't approximate an icon with the closest-sounding name from a theme's built-in icon
// library when the actual vector is one call away. Two-step process: (1) GET for a render URL,
// (2) GET that URL for the raw SVG text (Figma renders to a short-lived S3 URL, not inline data).
// The returned markup is always normalized via normalizeIconSvg before being handed back.
async function fetchFigmaIconSvg(url, accessToken) {
  if (!accessToken) {
    const err = new Error('FIGMA_TOKEN_REQUIRED');
    throw err;
  }
  const { fileKey, nodeId } = parseFigmaUrl(url);
  if (!nodeId) throw new Error('fetchFigmaIconSvg requires a URL with a node-id (one specific icon node).');

  const renderResp = await axios.get(`https://api.figma.com/v1/images/${fileKey}`, {
    headers: { 'X-Figma-Token': accessToken },
    params: { ids: nodeId, format: 'svg' },
    timeout: 20000,
  });
  if (renderResp.data.err) throw new Error(`Figma image render error: ${renderResp.data.err}`);
  const svgUrl = renderResp.data.images && renderResp.data.images[nodeId];
  if (!svgUrl) throw new Error('Figma returned no render URL for this node — is it a valid vector/icon node?');

  const svgResp = await axios.get(svgUrl, { timeout: 20000 });
  return normalizeIconSvg(svgResp.data);
}

module.exports = { fetchFigmaNode, fetchFigmaNodes, fetchFigmaIconSvg, parseFigmaUrl };
