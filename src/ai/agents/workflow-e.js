/**
 * Workflow E — Page/Section Configuration from a Design Image
 * Analyzes a design image and configures matching section(s) by reading each
 * section's own schema. The merchant may optionally name which section type
 * to use for each visual block; otherwise the agent infers it.
 *
 * When the task includes a Figma page link, this runs as: one shallow scan to
 * plan the section list, then ONE SEPARATE agent conversation per section
 * (each with its own tool-call budget, writing only its own section via
 * write_template_section) — so a 14-section homepage doesn't have to fit
 * inside a single conversation's iteration cap or keep every other section's
 * tool output in context. Without a Figma link (screenshot/prose only, no
 * discrete per-section node ids to split on) it falls back to one monolithic
 * conversation that reads/writes the whole template file itself.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { runAgentLoop } = require('./shared');
const { runFigmaColorSync } = require('./workflow-figma-colors');
const { runFigmaTypographySync } = require('./workflow-figma-typography');
const { fetchFigmaNode } = require('../../figma/fetch-figma');
const { listLocalFiles } = require('../../shopify/cli');
const { getSectionDisplayNames } = require('../../shopify/audit-section');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Split three ways instead of one shared blob, because every prompt-builder below used to get the
// same ~270-line rule dump verbatim regardless of whether it applied: CORE_RULES has no dependency
// on Figma data at all (schema-reading basics, full-field audit, richtext HTML validity) so it's
// relevant to every prompt including the screenshot-only monolithic fallback, which never calls
// fetch_figma_node and so can't use anything Figma-measurement-specific. FIGMA_MEASUREMENT_RULES is
// everything that only makes sense once real Figma data is in hand (highlights, box math, viewport
// detection, color/style fallbacks) — every OTHER prompt builder does always fetch Figma data, so
// they all get this group. GRID_AND_REPEAT_RULES (carousel/rating detection, mobile column counts)
// is specific to sections that can contain a repeating grid/carousel of items — true for a generic
// page section or a collection's product grid, not true for the PDP main block-order list or a
// single popup card, so those two skip it.
const CORE_RULES = `## Find and read the real section file
1. Get the theme's file list — call list_theme_files, unless the file list was already given to you
   above (per-section mode gives it to you upfront so you don't have to re-fetch the same unchanging
   list in every section's conversation).
2. Pick the closest matching file by name/purpose; if unsure between candidates, read both and
   compare their schema/markup against what the image actually shows
3. read_theme_file the section and read its {% schema %} block (section-level settings AND block
   types/settings) to get the real "id", "type", "default", and options for everything available.
   read_theme_file automatically resolves every "t:..." translation key in the schema against
   locales/en.default.schema.json before returning it, so what you read back is the actual real
   label/info text — never guess at what a "t:..." key might say, and never trust a setting's raw
   id or a Figma layer's name over that resolved label/info text (they can be misleading — e.g. an
   id like "desktop_layout" can turn out to mean the image's position, not the content's position;
   the resolved label settles it).

**Choosing between multiple block types in the SAME file.** Some section files define more than one
block type for the same kind of content (e.g. slideshow.liquid has "slide", "slide_text", and
"three_fold"). Before picking one, compare each candidate's own settings against the image's actual
structure — don't default to the first or simplest-looking one. Concretely: does the image show
text overlaid on top of one full-bleed image (a single content-position field placing text over the
image, e.g. "top-left".."bottom-right")? Or does it show image and text as two independent,
non-overlapping regions side by side (a left/right or top/bottom layout field, separate from the
image itself)? Read each candidate block's own settings list to tell these apart — the presence of
a dedicated image-position field (e.g. "desktop_layout") is what marks the split-layout kind.

## Map what you see in the image to real setting ids
Look at that block's portion of the image and identify whatever content/layout it shows —
alignment, position, heading, subheading, body text, buttons, item/column count, toggles, colors,
etc. — then match each to the closest setting in THAT section's own schema by its id/label
semantics. If the image shows something the schema has no field for, skip it — don't invent a key.

## Audit every touched block/section against its schema BEFORE writing — write EVERY field explicitly
Any optional setting you leave out of your JSON does NOT render blank — Shopify falls back to that
setting's "default" value from the schema, and that default is very often not what the design shows
(a non-empty text placeholder, a background tint, a grid-span that doesn't match the design's own
column count, a border, a divider). For EVERY block type and the section itself, go through its FULL
settings list top to bottom and write an explicit value for every field (color/dark-mode fields —
anything id/label "..._dark" or "(dark)" — are the one exception: leave those completely untouched
unless the task explicitly asks for dark-mode changes). Even when your answer matches the schema
default, write it anyway — the point is being forced to look up and decide on purpose, not to change
the number. write_template_section now also runs a code-level report (not a fix) listing every field
you left out, flagged louder when its default is a non-blank placeholder (a numbered slot like
\`icon_4\`/\`goal_3\` defaulting to a real icon or non-zero value, not blank/off) — treat that report as
a final safety net to catch what you missed, not a substitute for doing this audit yourself; it only
tells you what's missing, it never decides the right value or fixes it for you.

**Rich text fields (schema \`"type": "richtext"\`) require a valid HTML root — plain unwrapped text is
an invalid value and will fail validation on push.** Shopify enforces that every non-blank \`richtext\`
setting's top-level content is one or more \`<p>\`, \`<ul>\`, \`<ol>\`, or \`<h1>\`-\`<h6>\` tags — a bare
string like \`"On orders over £60"\` is rejected outright, it must be \`"<p>On orders over £60</p>"\`.
This is NOT the same as a plain \`"type": "text"\` field (which takes bare strings fine) — always check
the field's own \`"type"\` in the schema before deciding whether to wrap the value; wrapping a plain
\`text\` field's value in \`<p>\` tags it doesn't expect is equally wrong. An empty string \`""\` is safe
for either type.

**If a section type implied by the task or design doesn't actually exist in this theme
(list_theme_files/read_theme_file comes back empty/not-found), don't invent its field names onto a
different, existing file that merely sounds similar.** Flag the missing file in your summary and use
the closest REAL file's own actual schema fields instead — never copy setting ids from a section type
that isn't present in this theme. write_template_section also hard-rejects a write whose "type" has
no matching sections/*.liquid file at all, so this can't slip through even if you miss it.

**Global theme settings are out of scope here — flag, don't silently change.** If the design's fonts
(font family on headings/body text) clearly don't match this theme's global
\`config/settings_data.json\` typography settings (\`type_header_font\`, \`type_body_font\`,
\`heading_highlight_font\`), that's a site-wide concern beyond a single page/section task — note the
mismatch explicitly in your final summary instead of editing global settings_data.json yourself,
so the merchant can confirm before it affects every other page.`;

// Only relevant to a prompt that actually calls fetch_figma_node (every builder below except the
// screenshot-only monolithic fallback) — box math, mixedStyleRuns, fills/strokes, and viewport
// detection all require real Figma node data that simply isn't fetched in that one path.
const FIGMA_MEASUREMENT_RULES = `**Heading highlights — write_template_section checks this in code now, you don't have to.** A
Figma text node's \`mixedStyleRuns\` array (a phrase in a different color/italic from the rest —
see snippets/heading-highlight.liquid for the [bracket] convention this maps to) is cross-checked
automatically against whatever you write: if the run's exact text shows up in exactly one field,
the tool wraps it in \`[brackets]\` and sets \`highlight_type\` for you and tells you so in the result
("Auto-applied from Figma: ..."). It only reports (doesn't touch anything) when the same text
appears in more than one field, or doesn't appear at all — if you see a "Flagged" note like that,
that's on you to resolve by hand (transcription mismatch, or genuinely ambiguous which field it
belongs to).

**\`full_width\` / \`make_full_page_width\` (from layout math AS A PERCENTAGE of the artboard, not a
fixed px number, not artboard size).** Every top-level section frame in a Figma page is the same
width as the artboard — that is NOT evidence the section should bleed edge-to-edge; it's just how
Figma pages are laid out. Instead, compare the section's real *content* children (not a padding
wrapper — check one level deeper if the first child's own children still hug its edges, since a
full-bleed OUTER frame can contain an inner frame with real, non-full-bleed padding) against the
section frame width, AS A PERCENTAGE (gutter_px / artboard_width_px) — the specific numbers below
were measured on a ~1920px desktop artboard and will be proportionally smaller in px on a mobile
artboard (~375-430px), so always convert to a percentage before comparing, never compare mobile
gutters against these desktop px numbers directly:
- ~0-1.5% gutter each side (≈0-30px on desktop, ≈0-6px on mobile) → near-zero, genuinely full width
  → set \`full_width\`/\`make_full_page_width\`: true, only if the schema exposes such a field.
- ~13-14% gutter each side (≈250-270px on desktop, ≈50-60px on mobile) → this is the theme's normal
  \`page_width\`/standard side-margin container → leave at the schema default (do not force true).
- ~1.5-8% gutter each side (a small but non-zero margin, on EITHER viewport) → check the schema for
  a companion toggle — often named something like "padding_full_width" / "Enable side padding" —
  that a \`full_width\`-only section may need switched on too; without it, \`full_width\` alone can
  render completely edge-to-edge (0px gutter) instead of the small side padding the design actually
  shows. Read the section's own logic (the \`{% liquid %}\`/class-assignment block near the top of the
  file, before the markup) to see exactly what each combination of these settings produces.

**Button style/color — also checked in code now.** write_template_section reads any Figma node
named "...Button.../CTA" and derives its style (solid \`fills\` → primary, \`strokes\`-only → secondary,
neither → text-link) and its color, applying either to a block's matching field automatically when
there's exactly one unambiguous candidate — again reported back as "Auto-applied" or "Flagged". You
still need to give buttons sensible label/link text yourself; only the visual style/color is
fact-checked for you.

**Color overrides — check what the DEFAULT actually falls back to, not just "does it match some
global color".** Most color settings default to \`rgba(0,0,0,0)\` (transparent), meaning "inherit
something" — but which token it inherits varies per setting and isn't always the one you'd expect.
Before deciding a Figma fill is "already covered by the default, skip it": read the section's own
\`{% style %}\`/\`{% stylesheet %}\` block to see exactly which global setting (e.g.
\`settings.colors_background\` vs \`settings.secondary_background\`) that specific field falls back to
when left empty, then read \`config/settings_data.json\` for that specific token's current value.
Only skip the override if the Figma fill matches THAT fallback value — a Figma fill can coincidentally
equal a different global color than the one this particular field actually falls back to, which
still means you must set it explicitly or the section will render the wrong shade.

**Before relying on ANY background/style color override, actively search the schema for a gating
toggle and confirm it's on.** This is not optional and not just "if you happen to notice one" — many
sections in this theme need BOTH a color value AND a separate enable toggle before the color
actually renders (a common name for it in this theme is \`secondary_background\` with an option like
\`"section"\`, but it varies by file — search for it explicitly). Read the section's own
\`{% style %}\`/\`{% stylesheet %}\`/markup and confirm the color setting you're relying on isn't silently
gated behind another setting you forgot to flip, every single time you set a background color — not
just when something looks visually off. Background color completeness is ALSO checked in code
now (any solid fill covering a large share of a section/block is compared against that section's own
background-type fields, auto-applied when unambiguous) — but that safety net only catches what's
obviously a background; still deliberately check for the gating toggle yourself.

**Position/alignment settings — compute from box coordinates, and know WHICH box.** For a vertical
"position" setting (e.g. top/center/bottom), compare the content block's own box against its parent:
subtract to get the gap above (child.box.y - parent.box.y) and the gap below
(parent.box.y + parent.box.height - (child.box.y + child.box.height)) — equal gaps means centered,
a much smaller top gap means top-aligned, and so on. For a section/block-level "alignment" or
"text_alignment" SETTING (one value covering a whole heading/paragraph/row), do NOT read an
individual TEXT node's own \`font.align\` for this — that only reflects how text wraps *within* that
one run, which is very often "LEFT" even when the row/block AS A WHOLE is centered in its container.
Instead apply the same gap-comparison box math to the row/paragraph's own box against ITS parent —
equal left/right gaps means the setting should be "center", not "left", regardless of what any
individual line's \`font.align\` says. When the box math is ambiguous or missing, prefer the schema's
own default over guessing — most alignment defaults already match the common case.

**A value repeated across many sections is the theme's own default styling, not a per-section
override.** Things like heading font size are frequently expressed as a schema field (e.g.
\`heading_size\`, a percentage of a shared base size) rather than a fixed px value. If you measure the
same font size on headings across several different sections in the same design, that's the theme's
standard heading style rendering as-is — leave the corresponding schema field at its default. Only
set an explicit size override when THIS section's measured value genuinely differs from the pattern
you're seeing elsewhere in the same design.

**"Looks about the same size as other sections" is NOT enough to conclude a heading_size/title_size
field should stay at default — a SECTION-level heading field and a BLOCK-level heading field on the
very same page routinely use completely different percent→px formulas, so a block-level title
default can under- or over-render relative to what its own default "looks like it should be." Before
leaving ANY heading_size/title_size field at its schema default OR guessing a new value, trace the
actual formula: \`grep\` that section's own \`.liquid\` file for where the setting id feeds into a real
\`font-size: {{ ... }}rem\` (or \`px\`) rule — this theme's own common pattern is
\`rem = settings_id% * settings.heading_base_size% * <file-specific multiplier>\`, sometimes with an
extra \`* 0.8\` (mobile) or \`* <n>\` (a specific heading level) layered on in the actual CSS output line,
and \`settings.heading_base_size\` is a GLOBAL theme setting (read it from
\`config/settings_data.json\`, not assumed to be 100). Compute rem→px as \`rem * 16\` (this theme sets no
custom root font-size unless you find one), work out the percent value that reproduces the Figma
box's measured px height/font-size, then snap to that field's own \`step\` (e.g. steps of 10 — round to
the nearest valid multiple, don't leave a fractional un-steppable percent). Do this arithmetic
explicitly every time a title/heading looks even slightly off — never eyeball font sizing from a
screenshot or from "it renders about the same as elsewhere."

**Section padding — pick from the theme's own small set of spacing tokens, don't reverse-engineer
Figma's raw px gap.** \`padding_top\`/\`padding_bottom\` (and their \`_mobile\` counterparts, and the odd
file that names them \`top_padding\`/\`bottom_padding\` instead — check the real id) are NOT meant to
replicate a design's exact measured pixel gap; this theme's own sections consistently land on one of
three values: \`0\` (this section sits flush against its neighbor — zero visual gap in the design),
the schema's own \`"default"\` (no strong signal either way — most sections should just stay here), or
\`80\` desktop / \`40\` mobile (a genuinely large, deliberate breathing-room gap between distinct content
blocks). Don't set some other number (e.g. a Figma frame's own literal \`padding\` value like 60 or
100) just because it's what the design file happens to report — that number describes the Figma
canvas layout, not this theme's rendered spacing scale. When unsure which of the three buckets a gap
falls into, prefer the schema default over guessing a custom value.

**Detect which viewport a Figma source is for BEFORE mapping anything — a mobile design is not a
smaller desktop design.** Check the root frame's own \`box.width\` (whichever node the task/URL points
you at): roughly 320-480px means this data describes the MOBILE rendering; roughly 1280px+ means
DESKTOP. This changes what you do with every measurement and every setting id:
- Every gutter/full-width percentage, spacing token, and box-centering comparison in this file's
  other rules must be computed against MOBILE's own numbers when the source is mobile (e.g. its own
  ~13-14% side-margin convention, its own \`40\`-token for a generous section gap) — never reuse a
  desktop screenshot's absolute px thresholds (20px, 100px, 260px, ...) on mobile data; the same
  visual intent lands on very different absolute pixel counts at each scale.
- Target ONLY the \`_mobile\`-suffixed settings (\`padding_top_mobile\`, \`full_width_mobile\`,
  \`columns_mobile\`, \`image_alignment_mobile\`, \`heading_size\` is usually shared/unitless so check if
  it even has a mobile variant, etc.) — read the real schema field ids, don't assume every desktop
  field has an exact \`_mobile\` twin (some settings are viewport-shared, some mobile variants use a
  different suffix pattern like \`top_padding_mobile\` instead of \`padding_top_mobile\`, some don't
  exist at all for a given section). Never touch the plain (desktop) fields from mobile design data,
  and never touch the mobile fields from desktop design data.
- Real page CONTENT (heading text, body copy, button labels) is normally shared across viewports, not
  duplicated per-breakpoint in the schema — if a mobile design shows the exact same copy as the
  desktop version already configured, that's expected and needs no change; only flag it if the
  mobile design shows genuinely DIFFERENT text (e.g. a shortened mobile headline), since most section
  schemas have no separate "mobile heading" field to hold a variant at all.
- Before writing to a section that a prior pass may have already configured (the common case: doing
  a mobile refinement pass on top of an existing desktop build), call read_template_section FIRST to
  see what's already there, then call write_template_section with \`merge: true\` and ONLY the
  settings/blocks you're actually changing — this preserves every desktop setting and all block
  content untouched. Only use a full (non-merge) write when you're confident the section doesn't
  exist yet or you genuinely mean to replace it wholesale.

**Only one viewport's design is a completely normal, sufficient input — don't block waiting for
the other one.** A task giving you ONLY a mobile Figma frame, or ONLY a desktop one, is not missing
information: configure every field for the viewport you actually have real design data for (content
fields — text/images/links — are shared across viewports and should be set regardless of which
viewport's frame you're reading), and leave every \`_mobile\`-only or desktop-only LAYOUT field you
have no evidence for at the schema's own default rather than fabricating a value for the other
viewport or asking the user for it. If a design for the other viewport shows up in a later task,
that becomes a normal merge pass on top of what you already configured — it's not a prerequisite.
State plainly in your summary which viewport you configured from real data and which one is still
sitting at schema defaults, so it's easy for whoever's reviewing to know what's still open.

**A "select" option's real effect is defined by the section's own markup/CSS, never by what its
label sounds like.** Two options that both plausibly "sound right" for a measurement you're trying to
match (e.g. an image-width setting with only "medium"/"large" options for something that visually
looks like an even 50/50 split) must be resolved by reading the section's actual \`{% liquid %}\`/
\`{% stylesheet %}\` logic to see what percentage or class each option really produces — never pick
whichever option's label seems to fit the design's approximate proportions.

**A setting's real value must never be inferred from a coincidental keyword match between the
Figma layer's name and an option string.** E.g. a layer named "... Button Tab" does NOT necessarily
mean a \`tab_button_style\` setting (if the schema has one) should be set to its \`"button"\` option —
that's a name coincidence, not evidence of the actual visual style. Confirm from the schema's own
option labels/info text and the design's real visual structure; when genuinely unsure, leave the
schema default rather than pattern-matching a keyword.

**Before picking a section file by "what it sounds like it should be", check for a real file whose
name matches the Figma frame/layer's own name — but "name" means TWO different things here, and a
Figma layer typically describes the SECOND one.** A section's filename (e.g. "multicolumn.liquid")
and its actual admin-facing name (its schema's own \`"name"\`, e.g. "Text columns with icons" — what
shows in the Theme Editor's section picker) are frequently completely different words; a designer
naming a Figma layer almost always describes what they'd SEE in the editor, not the file path.
write_template_section double-checks both automatically after you write (comparing the Figma layer
name against every section's filename AND its resolved schema name) and flags either mismatch, but
catching it yourself first avoids configuring the wrong file's fields in the first place — when a
layer's name doesn't slug-match any filename, don't stop there; read a few candidate files' schemas
and check their own \`"name"\` too.

**When a section/block schema has a "Custom icon (SVG code)" field (or similarly-named raw-SVG/HTML
icon setting) and the Figma design shows a specific icon, fetch the REAL vector — don't guess the
closest-sounding name from the theme's built-in icon picker.** Call \`fetch_figma_icon_svg\` on that
icon's own Figma node (its "id" from a prior fetch_figma_node call — the icon/vector/component node
itself, not its parent row or a sibling text label) and paste the returned SVG markup directly into
that field. Still set the paired select-type icon field (e.g. \`icon_1\`) to any real non-"none" value
so the icon area renders at all — check the section's own markup/snippet logic, but a custom SVG
value typically takes rendering priority over the preset selection regardless of which preset is
picked. Decorative-pruned icon subtrees (a node collapsed to \`{decorative: true}\` in the summarized
JSON) still have a real Figma node id and are just as exportable — that collapse only means the
model wasn't shown the child path geometry, not that the icon is unavailable. Only fall back to
picking the closest built-in preset icon by name when the design's icon truly has no matching Figma
vector node to export (a generic/decorative icon with no source, or when fetch_figma_node never
surfaced its node id). \`{needsDeeperFetch: true}\` is a DIFFERENT flag and means the opposite of
decorative: it only appears when fetch_figma_node was called with a capped depth, and means this
node's real content (text, blocks, icons — anything) sits deeper than that depth reached. Never
treat it like decorative or skip the node — re-call fetch_figma_node on that exact node id with a
higher (or no) depth before deciding what it contains.`;

// Specific to sections that can hold a repeating grid/carousel of items (a generic page section, or
// a collection's product grid) — not applicable to the PDP main block-order list or a single popup
// card, neither of which has a repeating item grid to miscount.
const GRID_AND_REPEAT_RULES = `**"Scroll Bar"/"Carousel" → swiper_on_mobile, and "Rating Star" → show_rating/icon_star — both
checked in code now.** write_template_section scans for these Figma node names itself and flips the
matching schema field automatically (reported as "Auto-applied"); you don't need to hunt for them
yourself, but it's still worth noticing them in the design so the rest of your read of that section
makes sense (e.g. don't be surprised the tool touched a field you didn't set).

**Mobile column/grid counts must be read from the actual box math (row width ÷ item width, item count
per row) — a "2 columns" grid mobile setting/layout-select option is not automatically wrong just
because a section's schema default is "1 column" or "full width".** This project's earlier mistakes
included leaving a section at its default single-column/full-width layout when Figma's own box
positions clearly showed a 2-up (or N-up) grid — always compute the column count from the Figma boxes
directly rather than trusting whatever the schema ships as its default.`;

function buildSectionSystemPrompt(store, themeId, template, fileList) {
  return `You are a Shopify theme page architect working on store: ${store} (theme: ${themeId}).
Your job THIS conversation: configure exactly ONE section of a page to match its Figma design data.
You do not need to know or preserve the rest of the page's template — write_template_section
handles that for you (it splices your section into "${template}" without touching any other
section already there).

The theme's full file list has already been fetched once (below) and given to every section's
conversation this run, so you never need to call list_theme_files yourself — just read whichever
candidate section file(s) look closest by name/purpose:
${fileList.map((f) => `- ${f.key}${f.name ? ` (section name: "${f.name}")` : ''}`).join('\n')}

## Step 1 — Read the section's Figma data
The user message gives you this section's own Figma node URL, already the right one to fetch with
NO depth limit (a single section is small enough that a full-depth fetch is safe and accurate — you
get real text content, font family/size/weight, exact fill colors (hex), spacing/padding, corner
radius, and bounding boxes). Call fetch_figma_node on it before doing anything else. Treat this data
as ground truth for text content, colors, and sizing.

${CORE_RULES}

${FIGMA_MEASUREMENT_RULES}

${GRID_AND_REPEAT_RULES}

## Step 2 — Write this section
Call write_template_section with:
- template: "${template}"
- section_key: a descriptive snake_case key for this section (not the raw Figma node id)
- section: the complete { "type", "settings", "blocks", "block_order" } object
Then, in one short final message (this ends the conversation), summarize what you configured and
anything you skipped/flagged (schema had no matching field, collection/product reference left for
the merchant to assign, global font mismatch, etc.).`;
}

// The real block types main-product.liquid currently defines (excluding "@app", which isn't
// something you can add from a design). Given here so the model doesn't have to re-derive this
// list from scratch before it can even start comparing against the design — it still MUST
// read_theme_file the section to get each block type's own real setting ids before writing one.
const MAIN_PRODUCT_BLOCK_TYPES = [
  'product_name', 'product_sku', 'vendor', 'price', 'description', 'variant_picker', 'buy_buttons',
  'quantity_selector', 'volume_pricing_table', 'inventory_status', 'collapsible_tab',
  'social_sharing', 'text', 'size_chart', 'badges', 'estimate_delivery', 'separator', 'html',
  'rating', 'trust_badge', 'complementary', 'sticky_add_to_cart', 'gift_wrapping',
  'back_in_stock_alert', 'customize_picker', 'icon_text', 'feature_icon', 'collection_link',
  'frequently_bought', 'product_sibling', 'payment_methods', 'table_of_information',
  'nutrition_fact', 'horizontal_tab', 'engraving', 'button', 'coupon_code',
];

// The product page's main section is fundamentally different from every other section in this
// theme: it is NOT one visual block among several stacked sections — it's a single section
// ("main", type "main-product") whose own BLOCKS render as an ordered list inside the product-info
// column, right next to a media gallery that isn't a block at all but a set of section-level
// settings. Getting the block_order wrong (e.g. buy buttons before the variant picker, or the
// description above the price) is a much more visible, much more common mistake here than on a
// homepage, because on a PDP every visitor sees this exact order on every single product.
function buildProductMainSectionPrompt(store, themeId, template, fileList) {
  return `You are a Shopify theme page architect working on store: ${store} (theme: ${themeId}).
Your job THIS conversation: configure the PRODUCT PAGE's main section (key "main", section type
"main-product") to match its Figma design — both the product-info column's block order AND the
media gallery's layout settings. This section is structurally different from a normal stacked
"page section" — read this whole prompt before doing anything else.

The theme's full file list has already been fetched (below) — you still need read_theme_file on
"sections/main-product.liquid" for the real schema, this just saves you list_theme_files:
${fileList.map((f) => `- ${f.key}${f.name ? ` (section name: "${f.name}")` : ''}`).join('\n')}

## Step 1 — Read the Figma data for the WHOLE product-info + gallery area
The user message gives you the Figma node URL covering the full "above the fold" product area
(image gallery + title/price/variant/buttons/description column together) — fetch it with no depth
limit. This one Figma frame maps to this ONE section; do not split it into multiple sections.

## Step 2 — Read sections/main-product.liquid's real schema
This section defines ~35 block types, including (but verify against the real schema — this list can
drift): ${MAIN_PRODUCT_BLOCK_TYPES.join(', ')}. Read the schema's "blocks" array for the REAL settings
of each type you plan to use — don't assume a block's fields from its type name alone.

## Step 3 — Map the product-info column's content to blocks, in the EXACT Figma order
Walk the product-info column of the Figma frame TOP TO BOTTOM. For each visually distinct piece
(title, vendor, rating stars, price, a short subheading/tagline, variant swatches/buttons, a
quantity stepper, the add-to-cart/buy button(s), a trust/delivery-estimate strip, an accordion/tab
group for description or specs, a "frequently bought together" strip, payment-method icons, social
share icons, etc.), pick the closest real block type from Step 2 — never invent a block type, and
skip anything with no matching type (note it in your summary instead). The order you list these
blocks in "block_order" MUST match the Figma top-to-bottom order exactly — this is the single most
important thing to get right on this page, since it's what every visitor actually sees rendered.
A few blocks (\`description\`, \`collapsible_tab\`, \`table_of_information\`, \`horizontal_tab\`) can
hold body copy inside an accordion/tab — if the design shows the description as an expandable
row rather than a fully open plain paragraph, prefer \`collapsible_tab\`/\`description\` with its
"show_in_tab" style setting over dumping the text into a plain \`text\` block.

## Step 4 — Media gallery is SECTION-level settings, not a block
The product image gallery and its thumbnails are controlled entirely by settings on the "main"
section itself (there is no per-image "block" to create for the gallery — Shopify pulls the actual
images from the product's own media at runtime). Read the Figma layout and set, from the section's
real setting ids (verify exact ids/options against the schema, these are the ones to look for):
- Which side the image column sits on (a "desktop layout" left/right setting)
- How the gallery is arranged (a "desktop media layout" setting — options are typically a slider
  with a single visible image, a stacked list of full images, or a fixed 2-column grid; match
  whichever the Figma frame actually shows, don't default to whatever the schema ships with)
- Where thumbnails sit relative to the main image (a "thumbnail position" setting — horizontal strip
  below vs vertical rail beside it) — check the actual box positions of the thumbnail row/column
  in the Figma data (do the thumbnails' boxes sit below the main image, same x-range, lower y? or
  beside it, same y-range, to one side in x?) rather than assuming
- The main image's own aspect ratio (an "image ratio" setting) — measure the Figma image box's own
  width/height and pick the closest real option
- Whether zoom-on-hover is shown (an "enable image zoom" checkbox) — only if the design or task
  gives you actual evidence either way; otherwise leave the schema default

${CORE_RULES}

${FIGMA_MEASUREMENT_RULES}

## Step 5 — Write this section
Call write_template_section with:
- template: "${template}"
- section_key: "main"
- section: { "type": "main-product", "settings": {...}, "blocks": {...}, "block_order": [...] }
Then summarize the block order you produced (so it's easy to sanity-check against the design) and
anything you skipped or flagged.`;
}

// Collection pages in this theme split into two fixed special sections at the top — a banner
// (type "main-collection-banner") and the product grid itself (type "main-collection-product-grid")
// — followed by ordinary stacked sections below, same as a homepage. Neither special section has
// the same "long ordered block list" complexity main-product does (the grid just lists actual
// store products at render time, it has no per-product blocks to configure), so one prompt covers
// both.
function buildCollectionSpecialSectionsPrompt(store, themeId, template, fileList) {
  return `You are a Shopify theme page architect working on store: ${store} (theme: ${themeId}).
Your job THIS conversation: configure the collection page's two fixed top sections to match the
Figma design — a banner section (key "banner", type "main-collection-banner") and the product grid
section (key "product-grid", type "main-collection-product-grid"). Both come from the SAME Figma
frame you're given (the top "above the fold" area of the collection page) — split what you see
between the two real section types, don't invent a third section for this area.

The theme's full file list has already been fetched (below) — you still need read_theme_file on
both section files for their real schemas, this just saves you list_theme_files:
${fileList.map((f) => `- ${f.key}${f.name ? ` (section name: "${f.name}")` : ''}`).join('\n')}

## Step 1 — Read the Figma data
Fetch the given node URL with no depth limit — covers the collection banner (title/description
area, often overlaid on an image) and the product grid's own layout (columns, filters/sort bar if
shown).

## Step 2 — Read both section schemas
read_theme_file "sections/main-collection-banner.liquid" and
"sections/main-collection-product-grid.liquid". The banner usually has its own blocks (e.g. a
"description" block) for the title/copy area; the product grid is mostly section-level settings
(columns desktop/mobile, filter/sort visibility, image ratio) — it does not need per-product blocks,
those render from the real collection's actual products at runtime.

${CORE_RULES}

${FIGMA_MEASUREMENT_RULES}

${GRID_AND_REPEAT_RULES}

## Step 3 — Write both sections
Call write_template_section TWICE:
1. template: "${template}", section_key: "banner", section: { "type": "main-collection-banner", ... }
2. template: "${template}", section_key: "product-grid", section: { "type": "main-collection-product-grid", ... }
Then summarize what you configured for each and anything you skipped or flagged.`;
}

// Popups/overlays live in "sections/aside-group.json" (the theme's "overlay" group file, alongside
// quick-view, age-verification, cookie-banner) — a single floating section, not a stacked page, so
// it gets its own one-shot prompt rather than going through planSections/runPageSections at all.
function buildPopupSectionPrompt(store, themeId, fileList) {
  return `You are a Shopify theme page architect working on store: ${store} (theme: ${themeId}).
Your job THIS conversation: configure the promotional popup/overlay to match its Figma design. In
this theme, popups are NOT a page template — they live as one section ("popup-promotion" type) inside
"sections/aside-group.json", the theme's "overlay" group file (alongside quick-view, age-verification,
and cookie-banner, none of which you should touch).

The theme's full file list has already been fetched (below) — you still need read_theme_file on
"sections/aside-group.json" (to see the section's current key/position) and
"sections/popup-promotion.liquid" (for its real schema), this just saves you list_theme_files:
${fileList.map((f) => `- ${f.key}${f.name ? ` (section name: "${f.name}")` : ''}`).join('\n')}

## Step 1 — Read the Figma data
The user message gives you the popup's Figma node URL — fetch it with no depth limit. The frame
typically shows a full page mockup dimmed behind a semi-transparent overlay rectangle, with a smaller
floating card (the actual popup) as a sibling of that dimmed background — usually with rounded
corners, a heading, some body text (often mentioning a discount code), an email input, a button,
and a close control. Only the floating card itself is what you configure; the dimmed page behind it
is just Figma's way of showing context and isn't something you build.

## Step 2 — Read sections/popup-promotion.liquid's real schema
Read its section-level settings AND its block types (typically heading/text/button/email_form/
countdown_timer/social-icons — verify the real list, it can drift). Only add the blocks that the
Figma popup card actually shows — e.g. don't add a countdown_timer block unless the design actually
shows a visible countdown.

**Popup position — read from the card's box position within the FULL FRAME, not the dimmed
background instance.** The schema's \`popup_position\` is normally a 3x3 grid (top/center/bottom ×
left/center/right). Compare the card's own box against the full frame's box: compute the left gap
(card.box.x - frame.box.x) and right gap (frame.box.x + frame.box.width - (card.box.x +
card.box.width)) for the horizontal axis, and the equivalent top/bottom gaps for the vertical axis.
Roughly equal gaps on an axis means "center" for that axis; a much smaller gap on one side means
anchored to that side. A card that's roughly centered both ways (often with a dimmed full-viewport
overlay behind it) is a modal-style popup — set \`popup_position\` to whatever this schema's own
"middle center" / "center" option is, don't default to a corner value just because that's what the
schema ships with.

**\`content_position\` (or similarly-named image/content-side setting) — verify against the section's
own class-assignment logic, never assume the label describes the image or the text.** A field named
"content position" could mean "which side the content block renders on" OR it could be implemented as
a row-reverse toggle relative to markup order, which flips the meaning. Before setting this field,
read_theme_file the section's own \`{% liquid %}\`/class-assignment block (near the top of the file,
before the markup) and see literally what each option value does to the layout classes — then match
that against which side the Figma card actually shows the image on vs. the text on. Don't guess from
the option's label text alone.

${CORE_RULES}

${FIGMA_MEASUREMENT_RULES}

## Step 3 — Write the popup section
Call write_template_section with:
- template: "sections/aside-group.json"
- section_key: "popup-promotion" (this key already exists in the file — reuse it, don't invent a new one)
- section: the complete { "type": "popup-promotion", "settings": {...}, "blocks": {...}, "block_order": [...] } object
- Do NOT pass position_after — leave the popup's existing position in the group's "order" untouched.
Then, in one short final message (this ends the conversation), summarize what you configured and
anything you skipped or flagged.`;
}

// Fallback prompt for when there's no Figma link to split into per-section node ids (a screenshot
// and/or prose-only task) — one conversation reads/writes the whole template file itself, same as
// before this per-section refactor.
function buildMonolithicSystemPrompt(store, themeId) {
  return `You are a Shopify theme page architect working on store: ${store} (theme: ${themeId}).
Your job: look at a design (a screenshot) and configure the page's section(s) to match it. There is
no fixed catalog of "visual cue → setting id" — every section defines its own settings, so you must
discover them by reading each section's schema at runtime, never by memorized/guessed setting names.

## Step 1 — Identify the target sections
The task may name which section type to use for one or more visual blocks (e.g. "section 1:
slideshow"), or just describe the page in prose. Look top-to-bottom at the image and determine the
section boundaries and layout of each. Any names given in the task are hints for where to look and
what kind of section to expect — not guaranteed to be the exact filename, so still confirm by
reading the file.

${CORE_RULES}

## Step 3 — Read the existing template JSON before writing
read_theme_file the current templates/{page}.json first. If you're only reconfiguring specific
sections, preserve every other section/block/setting untouched and only change what the image
shows differently. write_theme_file needs the COMPLETE file content (not a diff), so patch in
memory, then write the full merged JSON back.

## Step 4 — Write and confirm
Write templates/{page}.json, set "order"/"block_order" to match the visual order, then summarize
which sections were added/changed and the key settings applied to each.`;
}

const FIGMA_URL_RE = /https?:\/\/www\.figma\.com\/\S+/;

function buildNodeUrl(baseFigmaUrl, figmaId) {
  const url = new URL(baseFigmaUrl);
  url.searchParams.set('node-id', figmaId.replace(':', '-'));
  // Drop tracking params that have nothing to do with addressing the node.
  url.searchParams.delete('t');
  return url.toString();
}

// One shallow (depth 2) scan + one small classification call — figures out which frame is which
// page template, and which of its children are real page-content sections vs theme-wide groups
// (header/footer/announcement bar/navigation, which live in header-group.json/footer-group.json,
// not a page template) worth iterating one-by-one. `templateOverride` skips asking the model to
// infer the template file — pass it when the caller (e.g. a multi-page site plan) already resolved
// which template this specific page frame maps to.
async function planSections(figmaUrl, task, templateOverride = null, excludeHint = null) {
  const shallow = await fetchFigmaNode(figmaUrl, process.env.FIGMA_ACCESS_TOKEN, 2);

  const planPrompt = `You are planning how to split a Shopify page-build task into one agent call per
section. You'll be given a task description and a shallow (depth 2) Figma scan of a page frame.

Return ONLY a JSON object: { ${templateOverride ? '' : '"template": "templates/xxx.json", '}"sections": [ { "figma_id": "1234:5678", "figma_name": "...", "task_hint": "..." or null } ] }
${
  templateOverride
    ? ''
    : `
- "template": infer the Shopify template file this page maps to from the task text (e.g. "homepage" → "templates/index.json", "product page" → "templates/product.json", "collection page" → "templates/collection.json"). Default to "templates/index.json" if genuinely ambiguous.`
}
- "sections": walk the frame's children TOP TO BOTTOM and list every node that is a real
  page-content section. EXCLUDE announcement bars, header/navigation groups, and footer groups —
  those are theme-wide sections configured separately (header-group.json/footer-group.json), never
  part of a page template's own section list. Watch for a generically-named wrapper (e.g. "Group",
  a Figma auto-layout artifact) that bundles the header together with the first real content
  section as siblings inside it (a very common pattern) — do NOT treat that whole wrapper as one
  section or you'll silently drop what's inside it; descend into it and evaluate ITS children
  individually instead, same exclude/include rule applied at that level.${
    excludeHint
      ? `\n- ALSO EXCLUDE: ${excludeHint} — that part of the page has already been configured by a separate
  step; only list sections that come after/below it.`
      : ''
  }
- "task_hint": if the task text names an explicit section type for this position (e.g. "section 1:
  slideshow"), put that hint here verbatim; otherwise null.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: planPrompt,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: `Task: ${task}\n\nShallow Figma scan:\n${JSON.stringify(shallow, null, 2)}` }],
      },
    ],
  });

  const text = response.content.find((b) => b.type === 'text')?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not plan sections from the Figma scan — no JSON found in planner response.');
  const plan = JSON.parse(match[0]);
  if (templateOverride) plan.template = templateOverride;
  if (!plan.template || !Array.isArray(plan.sections)) {
    throw new Error('Section planner returned an unexpected shape.');
  }
  return plan;
}

// Runs the full per-section pipeline for ONE page: plan its section list (or use templateOverride
// if the caller already knows the target template), then one fresh agent conversation per section.
// Product/collection templates get their fixed special top section(s) (main-product, or
// banner+product-grid) handled by a dedicated prompt BEFORE the generic per-section loop runs on
// whatever's left — see buildProductMainSectionPrompt/buildCollectionSpecialSectionsPrompt.
async function runPageSections(store, themeId, figmaUrl, task, templateOverride, fileList, storePassword, onProgress) {
  const changedFiles = [];
  const summaries = [];

  if (onProgress) onProgress(`[plan] Scanning Figma page (shallow) to identify sections...`);
  const plan = await planSections(figmaUrl, task, templateOverride);
  if (onProgress) onProgress(`[plan] Template: ${plan.template} — ${plan.sections.length} section(s) to configure`);

  let sections = plan.sections;

  if (plan.template === 'templates/product.json' && sections.length > 0) {
    const [mainSection, ...rest] = sections;
    sections = rest;
    if (onProgress) onProgress(`[main-product] "${mainSection.figma_name}" (${mainSection.figma_id})...`);
    const mainUrl = buildNodeUrl(figmaUrl, mainSection.figma_id);
    const systemPrompt = buildProductMainSectionPrompt(store, themeId, plan.template, fileList);
    const userText = `Task: ${task}\n\nThis is the full above-the-fold product-info + media gallery area — its Figma node URL (fetch with no depth limit): ${mainUrl}\nFigma layer name: "${mainSection.figma_name}"`;
    const result = await runAgentLoop(
      anthropic,
      systemPrompt,
      [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      store,
      themeId,
      storePassword,
      onProgress
    );
    changedFiles.push(...result.changedFiles);
    if (result.summary) summaries.push(`[main-product]\n${result.summary}`);
  } else if (plan.template === 'templates/collection.json' && sections.length > 0) {
    // Banner + product grid can appear as one combined Figma frame or two separate siblings —
    // take the leading 1-2 sections and let the dedicated prompt fetch/split them itself rather
    // than guessing the split here.
    const [bannerSection, maybeGridSection, ...rest] = sections;
    const gridIsSeparate = maybeGridSection && /grid|product/i.test(maybeGridSection.figma_name);
    sections = gridIsSeparate ? rest : sections.slice(1);
    if (onProgress) {
      onProgress(`[collection-special] "${bannerSection.figma_name}"${gridIsSeparate ? ` + "${maybeGridSection.figma_name}"` : ''}...`);
    }
    const bannerUrl = buildNodeUrl(figmaUrl, bannerSection.figma_id);
    const gridUrl = gridIsSeparate ? buildNodeUrl(figmaUrl, maybeGridSection.figma_id) : null;
    const systemPrompt = buildCollectionSpecialSectionsPrompt(store, themeId, plan.template, fileList);
    const userText = `Task: ${task}\n\nBanner area Figma node URL (fetch with no depth limit): ${bannerUrl}\nFigma layer name: "${bannerSection.figma_name}"${
      gridUrl
        ? `\nProduct grid Figma node URL (fetch with no depth limit): ${gridUrl}\nFigma layer name: "${maybeGridSection.figma_name}"`
        : '\n(No separate product-grid frame was identified — if the banner frame itself already shows grid-level details like column count, configure "product-grid" from that same data too.)'
    }`;
    const result = await runAgentLoop(
      anthropic,
      systemPrompt,
      [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      store,
      themeId,
      storePassword,
      onProgress
    );
    changedFiles.push(...result.changedFiles);
    if (result.summary) summaries.push(`[collection-special]\n${result.summary}`);
  }

  // Each remaining section gets its own fresh conversation and its own full tool-call budget — a
  // 14-section page no longer has to fit inside one runAgentLoop's iteration cap, and no section's
  // context has to carry the other sections' Figma data or schema reads.
  for (const section of sections) {
    if (onProgress) onProgress(`[section] "${section.figma_name}" (${section.figma_id})...`);
    const sectionUrl = buildNodeUrl(figmaUrl, section.figma_id);
    const systemPrompt = buildSectionSystemPrompt(store, themeId, plan.template, fileList);
    const userText = `Task: ${task}\n\nThis section's Figma node URL (fetch with no depth limit): ${sectionUrl}\nFigma layer name: "${section.figma_name}"${
      section.task_hint ? `\nExplicit hint from the task for this section: ${section.task_hint}` : ''
    }`;
    const messages = [{ role: 'user', content: [{ type: 'text', text: userText }] }];

    const result = await runAgentLoop(anthropic, systemPrompt, messages, store, themeId, storePassword, onProgress);
    changedFiles.push(...result.changedFiles);
    if (result.summary) summaries.push(`[${section.figma_name}]\n${result.summary}`);
  }

  return { changedFiles, summary: summaries.join('\n\n') };
}

// Detects a "whole file" Figma link (a CANVAS node, or a page listing multiple page frames) as
// opposed to a link to one specific page frame (e.g. "Homepage" itself) — the latter keeps today's
// single-page behavior via runPageSections directly. Returns null when the given link is already a
// single page frame, so the caller falls back to existing behavior unchanged.
async function discoverSitePlan(figmaUrl) {
  const shallow = await fetchFigmaNode(figmaUrl, process.env.FIGMA_ACCESS_TOKEN, 1);
  const root = Array.isArray(shallow) ? shallow[0] : shallow;
  if (!root || root.type !== 'CANVAS') return null;

  // One level deeper: page frames are frequently grouped inside a wrapper SECTION (e.g. "Design")
  // alongside sibling SECTIONs/FRAMEs for "Colors" and "Typography" — depth 2 reaches inside that
  // wrapper without paying for a full-depth fetch of every page.
  const deep = await fetchFigmaNode(figmaUrl, process.env.FIGMA_ACCESS_TOKEN, 2);
  const deepRoot = Array.isArray(deep) ? deep[0] : deep;

  const sitePlanPrompt = `You are mapping out an entire Figma design file for a Shopify theme build.
You'll be given a depth-2 scan of the file's root canvas. Identify three things:

1. The single frame documenting the theme's global COLOR palette (usually named something like
   "Colors", containing swatches for background/heading/text/button/etc — the same frame a
   color-sync step would read).
2. The single frame/section documenting the theme's global TYPOGRAPHY (usually named something like
   "Typography", showing font family/size specimens for body/heading text).
3. Every actual PAGE frame — a frame representing one whole page of the site (e.g. "Homepage",
   "Product page", "Collection page", or any other named page). Pages are often grouped as siblings
   inside one wrapper SECTION (commonly named something like "Design") alongside the Colors and
   Typography frames as separate siblings — descend into that wrapper if you see one, don't confuse
   it with a page itself. Skip anything that is clearly a component reference/preview rather than a
   full page (e.g. a lone "Header" or "Footer" frame sitting outside the page list).
4. A POPUP/OVERLAY frame — a frame named something like "Popup", showing a background page (often a
   full Homepage mockup) dimmed behind a small centered dialog/modal (a distinct smaller frame nested
   as a sibling of the dimmed background, usually with its own rounded-corner card containing a
   heading, some text, an email field, and/or a button, plus a close button). This is NOT a normal
   stacked page — it's a single floating overlay section. Only classify a frame this way if it
   genuinely shows a dimmed backdrop + floating card layered on top of a page background; a frame
   that's just one more ordinary full-width stacked section (even one with a form) is not a popup.

For each page, also decide which Shopify template file it maps to:
- A homepage → "templates/index.json"
- A product/PDP page → "templates/product.json"
- A collection/PLP page → "templates/collection.json"
- Any other named page (e.g. "About us", "FAQ") → a custom page template: "templates/page.<slug>.json"
  where <slug> is the page name lowercased, spaces replaced with hyphens (e.g. "About us" → "templates/page.about-us.json")
- A popup/overlay frame (see point 4 above) → the literal sentinel "sections/aside-group.json" (this
  routes to a dedicated popup-configuration step, not the normal per-section page pipeline — do not
  invent a "templates/page.popup.json" for this)

Return ONLY a JSON object:
{
  "colors_node_id": "1234:5678" or null,
  "typography_node_id": "1234:5678" or null,
  "pages": [ { "node_id": "1234:5678", "name": "Homepage", "template": "templates/index.json" }, ... ]
}
If you don't find a colors or typography frame, use null for that field — don't invent one. If
"pages" would end up empty, this probably isn't actually a multi-page file — still return the
object as-is (an empty "pages" array), the caller will fall back to single-page handling.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: sitePlanPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: `Depth-2 scan:\n${JSON.stringify(deepRoot, null, 2)}` }] }],
  });

  const text = response.content.find((b) => b.type === 'text')?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const plan = JSON.parse(match[0]);
  if (!Array.isArray(plan.pages) || plan.pages.length === 0) return null;
  return plan;
}

function dedupeChangedFiles(changedFiles) {
  const byKey = new Map();
  for (const file of changedFiles) {
    const existing = byKey.get(file.key);
    byKey.set(file.key, existing ? { key: file.key, reason: `${existing.reason}; ${file.reason}` } : file);
  }
  return [...byKey.values()];
}

async function runWorkflowE(store, themeId, task, storePassword = null, images = [], onProgress = null) {
  const changedFiles = [];
  const summaries = [];

  const figmaUrlMatch = task.match(FIGMA_URL_RE);

  if (!figmaUrlMatch) {
    // No Figma link — nothing to split into per-section node ids. Fall back to one monolithic
    // conversation over the screenshot/prose task, same as before this refactor.
    const systemPrompt = buildMonolithicSystemPrompt(store, themeId);
    const userContent = [];
    for (const img of images || []) {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    }
    userContent.push({ type: 'text', text: `Task: ${task}` });
    const messages = [{ role: 'user', content: userContent }];
    const result = await runAgentLoop(anthropic, systemPrompt, messages, store, themeId, storePassword, onProgress);
    changedFiles.push(...result.changedFiles);
    if (result.summary) summaries.push(result.summary);
    return { changedFiles, summary: summaries.join('\n\n') };
  }

  const figmaUrl = figmaUrlMatch[0];

  // Fetched once here (not per section/page) — the theme's file tree doesn't change during this
  // run, so every section conversation gets it for free in its opening message instead of
  // re-fetching it itself. Filtered to sections/ only: every prompt that receives this list uses
  // it for exactly one decision ("which section file matches this Figma layer"), so the other ~350
  // files (assets, snippets, locales, templates, blocks, config, layout) are pure noise here — they
  // were previously dumped in unfiltered, more than quadrupling what the model had to scan to find
  // the one directory that actually matters for this choice.
  //
  // Each entry is also tagged with its resolved admin-facing name (e.g. "multicolumn.liquid" ->
  // "Text columns with icons") right here, up front — not just checked after the fact. A Figma
  // layer's name usually describes what a designer SEES in the theme editor, which is this display
  // name, not the developer-facing filename; those two are completely different words for 40 of
  // this theme's 107 section files, so showing only the filename before was routinely missing the
  // one useful matching signal at the exact moment the model has to guess.
  const displayNames = getSectionDisplayNames(store, themeId);
  const fileList = listLocalFiles(store, themeId)
    .filter((f) => f.key.startsWith('sections/'))
    .map((f) => {
      const type = f.key.replace(/^sections\//, '').replace(/\.liquid$/, '');
      return { ...f, name: displayNames.get(type) || null };
    });

  if (onProgress) onProgress(`[discover] Checking whether this is a whole-file (multi-page) Figma link...`);
  const sitePlan = await discoverSitePlan(figmaUrl);

  if (sitePlan) {
    // Whole-file link: sync global Colors/Typography once (if found), then run the full
    // per-section pipeline once per discovered page, each against its own resolved template.
    if (onProgress) {
      onProgress(
        `[discover] Multi-page file — ${sitePlan.pages.length} page(s): ${sitePlan.pages.map((p) => `${p.name} → ${p.template}`).join(', ')}`
      );
    }

    if (sitePlan.colors_node_id) {
      const colorsUrl = buildNodeUrl(figmaUrl, sitePlan.colors_node_id);
      if (onProgress) onProgress(`[figma-sync] Syncing general colors from ${colorsUrl}...`);
      const syncResult = await runFigmaColorSync(store, themeId, colorsUrl, null, storePassword, onProgress);
      changedFiles.push(...syncResult.changedFiles);
      if (syncResult.summary) summaries.push(`[Figma color sync]\n${syncResult.summary}`);
    }

    if (sitePlan.typography_node_id) {
      const typographyUrl = buildNodeUrl(figmaUrl, sitePlan.typography_node_id);
      if (onProgress) onProgress(`[figma-sync] Syncing typography from ${typographyUrl}...`);
      const syncResult = await runFigmaTypographySync(store, themeId, typographyUrl, null, storePassword, onProgress);
      changedFiles.push(...syncResult.changedFiles);
      if (syncResult.summary) summaries.push(`[Figma typography sync]\n${syncResult.summary}`);
    }

    for (const page of sitePlan.pages) {
      if (onProgress) onProgress(`[page] "${page.name}" → ${page.template}`);
      const pageUrl = buildNodeUrl(figmaUrl, page.node_id);

      if (page.template === 'sections/aside-group.json') {
        // Popup/overlay: a single section inside the "overlay" group file, not a stacked page —
        // one dedicated agent conversation, no planSections/runPageSections fan-out.
        const systemPrompt = buildPopupSectionPrompt(store, themeId, fileList);
        const userText = `Task: ${task}\n\nThis is the "${page.name}" popup/overlay of a multi-page design — its Figma node URL (fetch with no depth limit): ${pageUrl}`;
        const result = await runAgentLoop(
          anthropic,
          systemPrompt,
          [{ role: 'user', content: [{ type: 'text', text: userText }] }],
          store,
          themeId,
          storePassword,
          onProgress
        );
        changedFiles.push(...result.changedFiles);
        if (result.summary) summaries.push(`[Popup: ${page.name}]\n${result.summary}`);
        continue;
      }

      const pageTask = `${task}\n\n(This is the "${page.name}" page of a multi-page design — configure it into ${page.template}.)`;
      const result = await runPageSections(store, themeId, pageUrl, pageTask, page.template, fileList, storePassword, onProgress);
      changedFiles.push(...result.changedFiles);
      if (result.summary) summaries.push(`[Page: ${page.name}]\n${result.summary}`);
    }

    return { changedFiles: dedupeChangedFiles(changedFiles), summary: summaries.join('\n\n') };
  }

  // Single-page link (today's original behavior): let planSections infer the template from the
  // task text itself.
  const result = await runPageSections(store, themeId, figmaUrl, task, null, fileList, storePassword, onProgress);
  changedFiles.push(...result.changedFiles);
  if (result.summary) summaries.push(result.summary);

  return { changedFiles: dedupeChangedFiles(changedFiles), summary: summaries.join('\n\n') };
}

module.exports = { runWorkflowE, discoverSitePlan, buildNodeUrl };
