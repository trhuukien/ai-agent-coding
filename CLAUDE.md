# AI Support Theme — Figma → Shopify page build playbook

This project builds/reconfigures a Shopify theme's pages from a Figma design, in exactly one of
two independent modes — pick one per run, they don't mix:

- **Mode 1 — API key.** `ANTHROPIC_API_KEY` is set. `npm start` runs `src/server.js`, which drives
  `src/agents/figma-page-agent.js` (+ `figma-colors-agent.js`/`figma-typography-agent.js`) fully
  automated via the Projects API/UI (`public/`) — no Claude Code session involved at all.
- **Mode 2 — Claude session.** No `ANTHROPIC_API_KEY` (or you're choosing not to use Mode 1's
  server). A Claude Code session performs every step itself, using the CLI tools in `scripts/`.
  **This entire file is Mode 2's playbook** — everything below assumes you (Claude Code) are the
  one doing the work, not `figma-page-agent.js`. Follow it top to bottom in a fresh session — don't
  ask the user to re-explain the process each time.

## Trigger

The user will send something shaped like EITHER of these:

```
setup theme <store>.myshopify.com theme <themeId>
figma: https://www.figma.com/design/<fileKey>/<name>?node-id=...
```

```
Setup: https://admin.shopify.com/store/<handle>/themes/<themeId>/editor
Figma: https://www.figma.com/design/<fileKey>/<name>?node-id=...
```

(exact wording varies — recognize it whenever a message combines a `figma.com/design/...` URL with
a store domain, an `admin.shopify.com/store/<handle>/themes/<themeId>` editor URL, and/or a bare
numeric theme id). The admin editor URL form already has a parser —
`parseThemeEditorUrl(url)` in `src/projects/store.js` — turning `.../store/<handle>/themes/<id>/editor`
into `{ store: "<handle>.myshopify.com", themeId }`; use that instead of hand-parsing the URL
yourself. If store+theme genuinely can't be determined from the message at all, ask before
starting — don't guess.

## Prerequisites (check once, at the very start)

1. `FIGMA_ACCESS_TOKEN` must be set in `.env` — check with:
   `node -e "require('dotenv').config({quiet:true}); console.log(!!process.env.FIGMA_ACCESS_TOKEN)"`
   If missing, tell the user and stop (Figma → Settings → Personal access tokens, "File content:
   Read-only" scope is enough).
2. Confirm you're in Mode 2 (see the top of this file) — i.e. don't assume `ANTHROPIC_API_KEY` is
   set, and don't ever start/rely on `src/server.js` for this work. You (the calling Claude Code
   session) perform every step below directly, using the scripts in `scripts/` and your own Agent
   tool for parallelism — you are not a fallback for a broken Mode 1, the two modes are just
   separate ways to run this project and you're doing Mode 2's job end to end.
3. **Local path convention:** a theme always lives at `theme/<store-handle>/<themeId>/` — the bare
   store handle (e.g. `kizchann`), never the full `<handle>.myshopify.com` domain. This is enforced
   in code, not just convention: `getThemeDir()` in `src/shopify/cli.js` strips any `.myshopify.com`
   suffix before building the local path, no matter which form of `store` you pass to any script —
   so it's safe to pass either `kizchann` or `kizchann.myshopify.com` to any `scripts/*.js` call,
   both resolve to the same `theme/kizchann/<themeId>/` folder. The real `shopify theme pull/push`
   CLI calls still always use the full `<handle>.myshopify.com` domain internally (required by the
   Shopify CLI itself) — this only affects where files sit on disk.
4. **Auto-pull, don't ask.** Once store+themeId are known (from either trigger form above), check
   whether `theme/<store-handle>/<themeId>/` already exists locally. If not, pull it yourself —
   don't ask the user how, this is no longer a manual/out-of-scope step:
   ```
   node scripts/pull-theme.js <store> <themeId>
   ```
   (`<store>` can be the bare handle or the full domain, see #3). If this throws an auth prompt
   (`AuthRequiredError` — a `userCode`/`authUrl` pair), surface that link+code to the user verbatim
   and wait for them to authenticate before retrying; that one step genuinely needs a human. Once
   pulled, proceed straight into the rest of this playbook — pulling is now part of the normal flow,
   not a separate confirmation point.

## The scripts you have (all in `scripts/`, all read `.env` themselves)

- All `figma-fetch-*`/`read-section-schema.js` output is **minified JSON, never pretty-printed**.
  This is read by Claude (directly or via a file an agent Reads), never scanned line-by-line by a
  human in a terminal — 2-space indentation on a deeply-nested Figma tree is pure whitespace with
  zero information value, measured at ~63-72% of a real fetched section's file size. If you need to
  eyeball one yourself for debugging, pipe it through `node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8')),null,2))"`
  rather than asking the fetch scripts themselves to pretty-print by default (Node is the only
  runtime this project depends on — don't reach for python/python3, it's not guaranteed to be
  installed). (This does NOT apply to the actual theme files under `theme/<store>/<themeId>/` —
  `templates/*.json`, `config/settings_data.json`, etc. stay pretty-printed, matching Shopify CLI's
  own convention and staying readable for a human opening them in an IDE or reviewing a git diff.)
- `figma-fetch-node.js "<url>" [depth]` — fetch one Figma node's full design JSON to stdout.
  Omit depth for a single small section; pass 2-8 for a whole-file/whole-page shallow scan.
  **Reading the result when `depth` was passed:** any container node that comes back with
  `"needsDeeperFetch": true` means the API's own depth cutoff stopped before reaching that node's
  real content — it is NOT confirmed empty, just not-yet-resolved. Never skip a node on the strength
  of this flag; re-fetch that specific node (deeper `depth`, or omit `depth` entirely if it's small)
  before deciding it has nothing worth configuring. Only `"decorative": true` (which the tool only
  ever sets on an unlimited-depth fetch, where the whole subtree was actually walked) means "real
  vector/icon artwork, genuinely nothing else in here, safe to leave as a flat stub." See the
  `figma-decorative-pruning-bug` note below for why this distinction exists.
- `figma-fetch-multi.js <list-file> <out-dir> [depth]` — batch-fetch several sibling nodes from
  the SAME file in one Figma API call (list-file: lines of `key|url`). Always prefer this over N
  separate `figma-fetch-node.js` calls when you already know you need several sections' data.
- `figma-fetch-icon.js "<url>"` — export ONE icon/vector node as real, normalized SVG (for any
  schema field labeled "Custom icon (SVG code)"). **Never** substitute a guessed built-in preset
  icon name when a schema has this field — always export the real vector.
- `figma-fetch-image.js <list-file> <out-dir> [scale]` — batch-render one or more Figma nodes as
  real PNG screenshots (same list-file format as `figma-fetch-multi.js`; a single-line file renders
  just one node). Use this to actually SEE a section, not just read its JSON tree — column count,
  whether a pagination-dot strip means a real carousel, true center/left/right alignment, are all
  things the JSON-only pipeline can only infer indirectly (box-gap math, layer names) and gets wrong
  often enough that this project's own past-mistakes list is full of alignment/carousel misses. This
  does NOT replace `figma-fetch-node.js`/`figma-fetch-multi.js` — exact text, hex colors, and every
  written setting still has to come from the JSON data, never guessed off pixels. Use images as a
  visual cross-check alongside the JSON, at two points in the workflow:
  1. **Step 1 (discover file structure):** render each page's own top-level children (the same
     nodes you're about to list from JSON) and count how many distinct visual blocks you actually
     see. If the image shows more blocks than the JSON's top-level children list, something is
     missing from the JSON side (a `MAX_CHILDREN` truncation, a node visibility quirk, etc.) —
     investigate before finalizing the section list, don't just trust the JSON count.
  2. **Step 5 (fetch full data, configure):** render each confirmed section's own node ALONGSIDE
     its Figma JSON, and hand both files to whichever subagent (or yourself) configures it. Read the
     image first for layout facts (columns, carousel yes/no, alignment), then use the JSON for exact
     content/values — never the reverse, and never skip the JSON in favor of eyeballing the image for
     text/colors.
  A single very tall page frame (e.g. a long mobile homepage) renders as one extremely tall/narrow
  image that gets downscaled illegibly by the viewer — don't render an entire page as one image.
  Render each already-identified top-level child/section node as its own separate image instead
  (one call, many node ids, same batching this script already does) — every section's own frame is a
  reasonable, legible aspect ratio on its own.
- `read-theme-file.js <store> <themeId> <file-key>` — read a local theme file with every `t:...`
  translation key already resolved to real English text. Use this for markup/logic (`.liquid`
  render code above `{% schema %}`), `locales/*.json`, `config/settings_schema.json` — anything
  that isn't "give me a section's schema" or "give me the live theme settings", which each have
  their own cheaper dedicated script (below) — **never** `read-theme-file.js` on
  `config/settings_data.json`, see the two settings scripts below.
- `read-settings-current.js <store> <themeId>` / `update-settings-current.js <store> <themeId>
  <patchJsonFile>` — read/patch ONLY the theme's live (light-mode) settings, never the whole
  `config/settings_data.json` file (which also carries N full preset objects, each nearly as large
  as the live settings themselves — on a real theme this was 84% of the file's bytes for something
  a colors/typography sync never needs). See step 2 below for the full usage pattern, including how
  these transparently handle a never-customized theme's `"current"` being a bare preset-name string
  instead of a real object.
- `check-font-name.js "<family name OR full handle>"` — validates a font against Shopify's own real
  font_picker library (`src/shopify/shopify-fonts.json`, store/theme-independent). Accepts either a
  bare family name as read off a Figma Typography specimen (e.g. `"Questrial"`) OR a full handle
  exactly as it's actually stored in `settings_data.json` (e.g. `"poppins_n4"`,
  `"playfair_display_i7"`) — parses the trailing `_[ni][1-9]` off a handle automatically before
  looking up the family, so you can check either form the same way. **Always** run this before
  writing any `font_picker` value — see step 2's dedicated note for why neither local validation nor
  Shopify itself reliably catches a typo'd or genuinely-unavailable font name otherwise.
- `read-section-schema.js <store> <themeId> <sectionType> [blockType ...]` — the ONLY way to read a
  section's `{% schema %}`. **Never** use `read-theme-file.js` on a `sections/*.liquid` file just to
  see its settings/blocks — that reads the WHOLE file (markup + schema together), and for a section
  with many block types (e.g. `main-product.liquid` defines ~35) the schema alone can be 10,000+
  lines; reading it in full every time is pure waste when a given Figma design only ever uses a
  handful of those block types. Read this two-phase instead:
  1. **Phase 1 — index (call with no block-type args):** returns the section's own top-level
     `settings` array in full (always small) PLUS just the LIST of available block types (`type` +
     admin `name` + how many fields each has) — no per-block field details yet. Compare this list
     against what the Figma design actually shows and decide which block types this design needs.
  2. **Phase 2 — detail (call again, passing only the block type names you decided you need):**
     returns the same section settings PLUS the FULL field definitions for ONLY those requested
     block types. Never request a block type "just in case" — only the ones you already matched to
     something visible in the Figma frame.
  On a small section (few block types total) this two-phase split still costs almost nothing extra
  and is never worse than a one-shot read — always use it, not just for the obviously huge files.
  **Icon-picker `select` fields (the ~80-value preset icon list) come back pre-compressed** to just
  `{ type, id, label, default, iconPickerNote }` — the options array itself is never repeated (it's
  identical across every icon field in this theme; measured 26% of one real section's entire
  phase-2 payload, all from this one static list copy-pasted per field). This loses NO information
  you actually need: per §5's own rule, a real exported `custom_icon` SVG always overrides whichever
  preset this field holds at render time, so the field's value only ever needs to be non-`"none"`
  (e.g. `"another_icon"`) — you never need the full option list to decide that. Only pick a real
  preset name from it (truck, gift, heart, star, leaf, award, ...) in the rare case where no Figma
  vector exists for that icon at all. `header`/`paragraph` schema entries (no `id` — pure Theme
  Editor UI text, never a writable field) are dropped from the output for the same reason: zero
  configuration information, never worth the tokens.
- `apply-section.js <store> <themeId> <template> <sectionKey> <sectionJsonFile> [positionAfter] [figmaDataFile] [merge]`
  — the ONLY way to write a section into a `templates/*.json` file. Runs the real
  `sanitizeSection` (type/range/select auto-correction) + `auditSectionAgainstFigma` (Figma
  cross-check, when `figmaDataFile` given) pipeline — never hand-edit template JSON with a raw
  `fs.writeFileSync`/Edit tool, you'll skip this validation.
- `validate-template-types.js <store> <themeId> [template ...]` — read-only, full type audit of
  every field in one or more templates against their real schema. Run this after EVERY batch of
  `apply-section.js` calls, no exceptions. Exit code 1 if anything's wrong.
- `pull-theme.js <store> <themeId>` — pulls the theme into `theme/<store-handle>/<themeId>/` (see
  the local path convention prerequisite above). Auto-run whenever the theme isn't pulled yet.
- `push-theme.js <store> <themeId> <fileKey> [fileKey ...]` — pushes exactly the file keys you list
  (relative to the theme root, e.g. `templates/index.json sections/header-group.json`) back to
  Shopify. Never push the whole theme — only the specific files a phase actually touched. See the
  auto-push rule under step 2 and step 6 for when to call this.

Put scratch files (fetched Figma JSON, section JSON payloads) in your scratchpad dir, never in
`scripts/` or the repo.

## Step-by-step

### 1. Discover the file structure

This project's Figma files follow a standardized top-level structure that mirrors the Shopify Theme
Editor's own navigation. The names in single quotes below are LITERAL — match them as exact strings
(verify with the real `name` field, not a semantic guess), the same way you'd verify a code
identifier:

- **'General Config'** — a top-level page/frame containing exactly these named children, each
  mapping 1:1 to a real "Theme settings" tab in Shopify's Theme Editor:
  - **'Colors'** → Theme settings > Colors.
  - **'Typography'** → Theme settings > Typography.
  - **'Product card'** (singular — confirmed exact name) → Theme settings > Product cards (see
    step 2's dedicated note for this group's real fields).
  All three live in `config/settings_data.json`'s `current` object (via
  `read-settings-current.js`/`update-settings-current.js`) — none of them are page templates.
- **'Template'** — a top-level page/frame containing every real page (Homepage, Product page,
  Collection page, custom pages) — map each to its Shopify template file as before (home→
  `templates/index.json`, product→`templates/product.json`, collection→`templates/collection.json`,
  anything else→`templates/page.<slug>.json`). Each page inside 'Template' may further split into
  **'Desktop layout'** / **'Mobile Layout'** children — one of the two, or both, can be present;
  for now just detect and report which exist per page (deeper dual-viewport handling logic is still
  being finalized, don't build it out further until told to).
- **Header/Footer.** These are shared across every page, so configure them ONCE (from whichever
  page you read them from — Homepage if there's a choice) BEFORE any per-page template work, never
  re-derive them separately per page. They can show up in either of two real shapes — check for
  both, don't assume one:
  1. As their own standalone Figma section/group somewhere under 'Template' (naming varies — this
     project's own files have used both `'Header'` and `'Sections - Header group'` for the same
     thing; match by what's actually inside it — menu/logo/announcement-bar content — not by
     expecting one exact literal string for this one specifically).
  2. Nested as direct children INSIDE a page frame itself (e.g. a page's own "Announcement bar" +
     "Logo above, menu center" children for Header, a "Footer" child for Footer) — if no standalone
     group exists, this is where to look instead, same as earlier sessions handled it.
  Map to `sections/header-group.json` / `sections/footer-group.json` either way.
- **'Overlay'** — 1 Figma section/group (found nested under 'Template') containing whichever
  overlay-type sections this specific design actually uses — confirmed real examples so far:
  `'Popup'`, `'Product labels and badges'` (multiple individual badge variants get merged into ONE
  frame like this, each variant becoming one block of that real section — don't treat each variant
  as its own separate section). `Quick view` is a plausible other example but confirm the REAL list
  actually present, never assume a fixed set. Maps to `sections/aside-group.json`.
  `read-theme-file.js <store> <themeId> sections/aside-group.json` FIRST to see the real existing
  keys/types already in that file, then match each Figma child to the correct EXISTING key by its
  `type` — reuse existing keys, never invent new ones or place content in whatever slot seems
  convenient. (See the dedicated "Popup" note under step 3 for the specific rules on configuring a
  popup card once matched; the same read-real-keys-first discipline applies to every other type
  found in this group, not just popups.)
- **Anything else at the top level that doesn't match 'General Config', 'Template', or a
  Header/Footer/Overlay shape** (e.g. a leftover legacy color-reference section from before this
  file adopted the standardized structure) — don't force-fit it into one of the categories above.
  Don't stop to ask — skip it and continue, but call it out plainly in the final report (step 7)
  so it's a visible, reviewable decision rather than a silent omission.

`figma-fetch-node.js` the root/canvas URL at depth 1, then depth 2 (deeper as needed to look inside
'Template' for Header/Footer/Overlay), to locate all of the above and confirm exactly which
pages/groups exist.

**Check each page frame's own root `box.width` — desktop (~1280px+) vs mobile (~320-480px).** This
project's Figma files are usually desktop-only (as this session's was), but don't assume that by
default — some files provide a SEPARATE mobile frame per page (e.g. sibling frames "Homepage
Desktop" / "Homepage Mobile", or a whole separate page-frame set under a "Mobile" canvas/section).
If only one viewport exists for a page, that's a completely normal, sufficient input — configure
every field you have real data for and leave the OTHER viewport's `_mobile`-suffixed (or plain,
if the data you have is mobile) fields at schema default; state plainly in your final report which
viewport was actually configured from real data, so it's obvious what's still open. If BOTH exist,
treat them as two data sources for the SAME section (shared content fields — text/images/links — set
from either, once; layout fields — columns, spacing, alignment — set separately per viewport's own
`_mobile` vs plain field ids). Never reuse desktop absolute px thresholds/measurements on mobile data
or vice versa — always convert to a percentage of that frame's own width before comparing.

**Cross-check the section count visually before finalizing this list.** Render each page's own
top-level children as PNGs via `figma-fetch-image.js` (one batched call, all children of a page at
once) and count the distinct visual blocks you actually see. If the image shows more blocks than
the JSON's top-level children list, something is missing from the JSON side (truncation, a
visibility quirk, a node the fetch never surfaced) — go find it before finalizing, don't trust the
JSON child count alone. This is the single cheapest place to catch a missed section, before any
deep-fetch or subagent work has been spent on an incomplete list.

Tell the user this file/page breakdown (including which viewport(s) you found per page), then
proceed straight into full-depth fetching — don't stop and wait for a go-ahead. This report is
informational, not a checkpoint; if something in it turns out wrong, it gets caught and fixed
during step 5/6's own validation rather than by pausing here.

### 2. General config ('Colors' + 'Typography' + 'Product card') — do this FIRST, before any page

**Never read `config/settings_data.json` directly for this step** (via `read-theme-file.js` or any
other means) — it also carries N full preset objects (each nearly as large as the live settings
themselves; on a real theme this was 84% of the file's bytes) that a colors/typography sync never
needs to see. Use the two dedicated scripts instead:
- `read-settings-current.js <store> <themeId>` — prints ONLY the resolved live settings object.
  Handles both real `settings_data.json` shapes transparently: a merchant-customized theme where
  `"current"` is already a full object, AND a never-customized theme where `"current"` is just a
  bare string naming which preset is active (Shopify's own untouched-since-install state) — either
  way you get back the real effective values, never the raw presets blob.
- `update-settings-current.js <store> <themeId> <patchJsonFile>` — `patchJsonFile` is a small JSON
  object of ONLY the `{ "setting_id": newValue }` pairs you're actually changing (never the full
  settings object). If `"current"` is still a bare preset-name string (never-customized theme), this
  always promotes it to a real object first (cloning that preset's values), same as Shopify's own
  theme editor does the moment anything is changed — this happens on every call, even one whose
  patch turns out to match already, so only call this once you're sure at least one value genuinely
  needs to change (compare against `read-settings-current.js`'s output yourself first). Never touch
  `_dark` keys unless explicitly asked. Prints only the changed keys (old → new), never the whole
  file.

**Colors**: `figma-fetch-node.js` the Colors frame at depth ~9 (yes, this deep — the real swatch
color lives in a nested `_colorbox-thumb` instance one level past where it first becomes visible;
depth 6 will show you the outer chip's own fill, which is often just a neutral wrapper color, not
the real swatch — verify by walking to the `_colorbox-thumb` child specifically, don't stop at the
first fill you see). Match each swatch's label (its sibling TEXT node's `characters`, not the Figma
layer `name`, which can be stale) against `read-theme-file.js ... config/settings_schema.json`'s
light-mode `colors` settings group, by resolved label semantics — cross-check against
`read-settings-current.js`'s output for the values already there, and only include an id in your
patch file whose Figma value actually differs.

**Typography**: `figma-fetch-node.js` the Typography frame, full depth (it's small). It's laid out
as label/value row pairs sorted by `box.y` then `box.x` — do NOT trust the frame's own rendered
font style for family/weight (the specimen text is often set in a generic UI font like Roboto to
LABEL a family name, it is not a live sample of that family). To get the real weight, fetch a real
page (e.g. the Homepage) and read actual heading/body TEXT nodes using that family — their own
`font.weight` is the ground truth. Shopify font handles follow
`{lowercase_underscored_family}_{n|i}{first-weight-digit}` (e.g. "Raleway" weight 700 → `raleway_n7`).

**Before writing ANY font_picker handle, run `check-font-name.js "<family name>"` first.** Neither
`sanitizeSection`/`validate-template-types.js` nor Shopify itself reliably catches a wrong
font_picker value at write/push time — an unrecognized handle just silently falls back to a system
default font at render time on the live storefront, with no error anywhere, so this is the ONLY
real check available and skipping it is how a typo (`ralewey_n4` instead of `raleway_n4`) or a
design that specifies a genuinely non-Shopify custom font reaches production undetected:
- **Exact match** → proceed, compute the handle normally.
- **Not found, but a close suggestion exists** (small edit distance, e.g. "Ralewey" → "Raleway") →
  this is almost always a typo in the Figma layer/text itself — flag it in your summary and use the
  suggested REAL name, don't silently "correct" it without saying so.
- **Not found, no close suggestion** → this is very likely a genuinely custom font that Shopify's
  font_picker cannot reference at all (it only supports fonts from its own library, mostly Google
  Fonts — it can't point at an arbitrary uploaded font file). Do NOT invent a handle for it. Flag
  this explicitly: using a real custom font requires uploading a font asset and writing custom
  `@font-face` CSS (a Workflow-B-style global-CSS change), which is out of scope for a
  `settings_data.json` font_picker patch — surface this to the user/developer as a decision point,
  don't silently substitute the closest-sounding real font instead.
- This local list (`src/shopify/shopify-fonts.json`) was scraped from Shopify's own published font
  documentation and can go stale as Shopify adds fonts over time — treat "not found" as a strong
  signal to double-check by hand in the real Theme Editor's Font Picker, not as absolute proof the
  font doesn't exist.

**Product card**: `figma-fetch-node.js` the 'Product card' frame (singular — that's the real Figma
name; the Shopify setting it maps to is titled "Product cards", plural, don't confuse the two names
when grepping for either), full depth (it's a small specimen, usually one or two sample
product-card mockups showing image/title/price treatment, not a real page). This group's real
fields live under the "Product cards" header inside
`config/settings_schema.json`'s bigger cart/product settings group — bounded from that header down
to the NEXT header (`grep -n '"type": "header"' config/settings_schema.json` to find both
boundaries, don't assume the field list from memory since it can drift). The real ids you're
looking for (verify against the actual file, this is what existed at the time of writing):
`title_size_card`/`price_size_card` (heading/price font-size scale — same `%`-of-base-size formula
as any other heading_size field, see the box-gap/formula rules under step 5), `product_image_ratio`
(select: natural/square/landscape/portrait/wide/3:4 — measure the card's real image box aspect
ratio and pick the closest), `product_image_type` (select: none / hover-to-reveal-second-image /
slide — only set to something other than the schema default if the Figma mockup actually shows
evidence of a second image or a slide indicator, otherwise you have no way to know from a static
card and should leave the default), `card_product_padding` / `card_product_padding_mobile` (px
range — measure the real padding around the card's content, not a guessed round number),
`card_product_background_color_light`/`_dark` (background — check the fallback-token rule from
step 5 before overriding), `info_alignment_card_product` (select: left/center/right — compute from
box-gap math against the card's own width, never from `font.align`, same rule as everywhere else).
Skip `product_card_effect_reveal_image`, `number_of_additional_images`, `transition_arrows*`,
`show_arrow`, `change_slides_speed` unless the Figma card specifically shows evidence of a
hover/slide image transition (these only matter when `product_image_type` isn't `none`) — don't set
them just because they exist in the schema.

Report the diff (`update-settings-current.js`'s own printed output already gives you old → new per
changed id).

**Auto-push this phase before moving on.** Once general config is written, push it immediately —
don't batch it together with page work, and don't wait for a manual go-ahead:
```
node scripts/push-theme.js <store> <themeId> config/settings_data.json
```
If the push itself errors (CLI/auth failure) or `update-settings-current.js` had already flagged
something on write, fix it right now and re-push before starting step 3 — never carry a known-bad
general config forward into page work. Only once this push succeeds do you move on to pages.

### 3. Per page: discover sections

`figma-fetch-node.js` the page frame at depth 3 to list its top-level children. From that list:
- **Exclude**: Announcement bar, Logo/menu/header frames (→ `header-group.json`, separate concern),
  Footer (→ `footer-group.json`), any bare decorative divider/line with no real content.
- **PDP special case**: the "Product information" (or similarly named) frame — the media gallery +
  title/price/variant/buttons column — is NOT a normal stacked section. It configures the single
  `main-product` section's block order + section-level gallery settings (see step 5).
- **Collection special case**: "Collection banner" + "Product grid" (or similarly named) are the
  two fixed `main-collection-banner` / `main-collection-product-grid` sections — usually the ONLY
  two sections on this page.
- Anything left is a normal stacked page section, one per visually distinct block.

**'Overlay' group.** This is a standalone Figma group (see step 1) containing every overlay-type
section this design actually uses — commonly a promo popup, `product-labels-and-badges`, and/or
`quick-view`, but confirm the REAL children present, don't assume a fixed set. None of these are a
page or a page section — they all live inside `sections/aside-group.json` (the theme's "overlay"
group file, alongside `cookie-banner`/`store-selector`, which you should leave untouched unless the
'Overlay' group's own children actually include them).
0. `read-theme-file.js <store> <themeId> sections/aside-group.json` FIRST, for every child in this
   group — find the EXISTING key whose `type` matches what that Figma child actually is (e.g. a key
   with `type: popup-promotion` for a popup card, `type: product-labels-and-badges` for a badges
   spec, `type: quick-view` for a quick-view card). Reuse the exact existing key every time — never
   invent a new one or duplicate an existing type. Configure each child with its own
   `read-section-schema.js` call (two-phase, same as any normal section) and write it with
   `apply-section.js` against `sections/aside-group.json`, passing that child's real existing key.

**Popup card specifics** (when one of the 'Overlay' children is a popup): a frame showing a full
page mockup dimmed behind a semi-transparent overlay, with a smaller floating card
(heading/body/email-field/button/close-control) as a sibling of that dimmed background, is what you
configure — only the floating card itself, never the dimmed backdrop (that's just Figma's way of
showing context). Don't misclassify an ordinary full-width stacked section (even one with a form)
as a popup just because it has similar content.
1. `read-section-schema.js <store> <themeId> popup-promotion` — typical blocks:
   heading/text/button/email_form/countdown_timer/social-icons, but verify the real list, it can
   drift. Only add blocks the card actually shows (e.g. don't add `countdown_timer` unless a
   visible countdown is in the design).
2. `popup_position` is a real 3x3-grid select field (`top-left` … `bottom-right`, plus `center`).
   Compute it from the card's own box against the FULL FRAME's box (not the dimmed-background
   instance specifically, though it's normally the same box): left gap = `card.box.x - frame.box.x`,
   right gap = `frame.box.x + frame.box.width - (card.box.x + card.box.width)`, same for top/bottom.
   Equal gaps on an axis → centered on that axis; a much smaller gap on one side → anchored there. A
   card roughly centered both ways is a modal-style popup → use this schema's own "center"/"middle
   center" option, don't default to a corner just because that's the schema default.
3. Any `content_position`/image-vs-text-side field on this schema must be verified against the
   section's own `{% liquid %}` class-assignment logic (near the top of `popup-promotion.liquid`)
   before setting — the same rule as any other section's layout field, never inferred from the
   option's label text alone.
4. Write it via `apply-section.js` against `sections/aside-group.json`, using the EXISTING key from
   step 0, and do NOT pass a `positionAfter` — leave the popup's current position in that file's own
   `order` untouched.

**Other 'Overlay' children** (`product-labels-and-badges`, `quick-view`, etc.): no special
position/backdrop math needed — configure them exactly like a normal section (§4-§5's rules apply
in full), just writing to `sections/aside-group.json` with their own existing key instead of a page
template.

If any frame's name is generic (`Frame 2147225xxx`) and its content isn't obviously nameable, say so
and ask the user to rename the Figma layer to something descriptive — don't guess a section type
from an unclear name. (They may rename mid-session; re-fetch depth 3 once more before finalizing if
so — renamed layers routinely resolve real ambiguity, e.g. "Frame 2147225582" → "Product
specifications" told us exactly which real section file to use.)

Present the full section list (with your best-guess section-file mapping per item), then move
straight into fetching full data / dispatching work — don't stop for a go-ahead here. (The generic
frame name case just above is the one real exception: that's missing information, not a plan to
approve, so it still needs an actual answer before you can name that one section.)

**Multi-slide/multi-state sections (slideshows, scrollable carousels/rows).** A single static Figma
frame can only ever show ONE state of anything that changes over time or scroll position — a
slideshow's page frame shows just its first slide, a horizontally-scrolling category row shows just
its initial scroll position. The required convention for this project: the designer nests every
extra slide/state directly INSIDE the section's own node as child frames, named `<section
name>_<N>` (e.g. a page section named "Slideshow" contains children "Slideshow_1", "Slideshow_2",
"Slideshow_3" — sequential numeric suffix, one child per slide, in top-to-bottom/order-in-panel
order). No separate grouping container elsewhere on the canvas is needed — the section node being
BOTH the thing you'd normally treat as one inline section AND the parent of its own N numbered
slide children is what signals "this is N slides of one section," not N separate sections. Do NOT
accept bare naming coincidence (frames that just happen to share a name with no actual parent/child
nesting relationship) as reliable enough to treat as the same section's extra slides — the nesting
itself is the signal, not the name alone.

When discovering sections (this step), for any top-level section frame, check whether ITS OWN
children (one level deeper than the page's own top-level scan) are named `<that section's own
name>_1`, `<...>_2`, etc. If so, that section has N slides/states, not "just some nested content" —
note the count when presenting the plan to the user (e.g. "Slideshow (3 slides: Slideshow_1,
Slideshow_2, Slideshow_3)").

### 4. Pick the REAL section file — do not skip this even when a name seems obvious

1. `grep -rn '"name":' theme/<store>/<themeId>/sections/*.liquid` for the schema's own admin-facing
   `name` field and compare against the Figma layer's name — a matching *schema name* (not
   filename) is strong evidence, but ALSO check the file actually fits the content (some homonyms
   exist, e.g. two different "Collection banner"-named files for different templates — see below).
2. **Always check `enabled_on`/`disabled_on` in the candidate file's own `{% schema %}` before
   committing to it.** This is not optional. A file can have the exact right-sounding name/content
   shape and still be restricted to a completely different template (e.g.
   `email-signup-banner.liquid` is `"templates": ["password"]`-only — wrong for a homepage
   newsletter block even though its content matches; `main-collection-list-banner.liquid` shares its
   schema `name` with `main-collection-banner.liquid` but is `"templates":
   ["list-collections"]`-only — wrong for a single collection page). Grep the raw file for
   `"templates"`, `"enabled_on"`, `"disabled_on"` — don't rely on `read-theme-file.js`'s
   translation-resolved output alone catching this, read the raw structural JSON keys directly.
3. If the content genuinely doesn't fit ANY real file's schema (e.g. a Figma "ingredient table" that
   turns out to need per-product/metafield references, not free-text rows — always verify a
   candidate file's block settings actually hold what the design shows, don't assume from the
   file's general category), say so explicitly and look for a better real file rather than
   force-fitting fake block content into the wrong one.

### 5. Fetch full data, then configure

Batch-fetch every confirmed section's Figma node via `figma-fetch-multi.js` (one API call, not N).
**For a section with numbered `_N` slide children (§3)**: fetch each numbered child (`Slideshow_1`,
`Slideshow_2`, `Slideshow_3`, ...) as its own entry in the SAME batched fetch, using keys that
preserve the number (e.g. `slideshow_1`, `slideshow_2`, `slideshow_3`) — never fetch just the parent
"Slideshow" node alone and assume it shows everything, the individual slide content lives in the
numbered children. Hand ALL of these files to the SAME single subagent for that section (never
split one section's slides across multiple subagents) and tell it plainly: "these N files are N
slides of the SAME section, in this exact numeric order — build one `block_order` covering all of
them," rather than letting it discover the relationship itself.

Also render each confirmed section's own node as a PNG via `figma-fetch-image.js` (batch these in
the same pass, one call, many node ids — never N separate calls) alongside the JSON fetch.

For each section, either configure it yourself or dispatch one Agent-tool subagent per section to
run in parallel — give each subagent: the theme dir path, its own pre-fetched Figma JSON file
path(s) AND the matching pre-rendered PNG file path (tell it to Read the files directly, not call
any Figma tool itself), and the section's confirmed file/type. Ask each subagent to return ONLY a
fenced JSON section object as its final message (`{ "type", "settings", "blocks", "block_order" }`)
plus a short prose summary — never have subagents call `apply-section.js` themselves, since
concurrent writes to the same template file race. YOU write all of them sequentially and in the
page's real top-to-bottom order once every subagent has returned.

Rules every subagent (or you, doing it directly) must follow:
- **Look at the section's rendered PNG first for layout facts** (column count, whether a
  pagination-dot strip means a real carousel, true center/left/right alignment) — this is what the
  image is for; never guess these from box-gap math when a real screenshot is sitting right there.
  Then **analyze the Figma JSON for every visually distinct piece, then read schema — never the
  other way round.** Walk the section's pre-fetched Figma JSON and list, in plain words, every
  visually distinct piece it shows (title, price, a 3-item icon row, an accordion group, a CTA
  button, etc.) BEFORE reading any schema. Only then call `read-section-schema.js <store> <themeId>
  <sectionType>` with NO block-type
  args (phase 1 — the cheap index) and match each piece you listed against the returned block-type
  names. Call it a SECOND time passing only the block type(s) you actually matched (phase 2 — full
  field detail for just those) — never request a block type "just in case", and never fall back to
  reading the whole `.liquid` file with `read-theme-file.js` to "see everything" instead. For
  multi-block-type files like `main-product.liquid` (~35 types) this is the difference between
  reading ~700-800 lines and reading 15,000+.
- Never memorize/guess a field id — every id you write must come from what phase 2 actually
  returned for that block type.
- Write EVERY field explicitly (except `_dark`/"(dark)" fields) — an omitted field falls back to
  its schema default, which is very often non-blank placeholder content.
- `richtext` fields need a `<p>/<ul>/<ol>/<h1-6>` root — wrap bare strings; plain `text` fields take
  bare strings as-is.
- **Alignment/position fields: compute from box-gap math (child box vs. parent box, left-gap vs.
  right-gap), never from a single TEXT node's own `font.align`.** `font.align` only describes how
  text wraps within one run — a centered block routinely contains a TEXT node whose own align is
  "LEFT". This was the single most common real mistake this project has produced — check it twice.
- **Custom SVG icon fields**: if the schema has a `"type": "html"` field literally labeled "Custom
  icon (SVG code)" and the design shows a specific icon, `figma-fetch-icon.js` the real vector node
  and paste the real SVG in. Do not pick a built-in preset icon name as a substitute when this field
  exists — that was the second most common real mistake.
- Product/collection/video/image references that don't exist in Figma (they never do — Figma has no
  concept of a real Shopify resource) get left blank/empty-array for the merchant, explicitly noted
  in the summary, never invented.
- A section whose content doesn't map to any real field in its own schema: skip that piece, note it
  — never invent a field id.

### 6. Write sequentially, then validate

For each section, in page order:
```
node scripts/apply-section.js <store> <themeId> templates/<page>.json <sectionKey> <sectionFile.json> "" <figmaDataFile>
```
(pass `""` for positionAfter on a fresh template — appending in the correct call order already
produces the right final order). Read each call's printed `notes` — an "Auto-applied" note is
informational, a "Flagged" note needs your own judgement call, don't just ignore it.

**Before writing to a template that already has section content**: don't stop to ask, don't weigh
demo-content vs. merchant-content signals — always replace. Reset the file and rebuild it from
scratch every time, no exceptions, no "does this look real" judgement call. State plainly in the
final report (step 7) which templates were reset — visible for review, not a gate on progress.

To reset a template to empty before a from-scratch rebuild:
```js
const fs = require('fs'), path = require('path');
const filePath = path.join('theme/<store>/<themeId>', 'templates/<page>.json');
const raw = fs.readFileSync(filePath, 'utf8');
const header = (raw.match(/^\/\*[\s\S]*?\*\//) || [''])[0];
fs.writeFileSync(filePath, (header ? header + '\n' : '') + JSON.stringify({ sections: {}, order: [] }, null, 2) + '\n');
```

**After every batch of writes to a template, run:**
```
node scripts/validate-template-types.js <store> <themeId> templates/<page>.json
```
Zero issues before you report anything as done. If it finds something, fix it with another
`apply-section.js` call (or a small direct patch + re-run the validator) — never leave a known type
mismatch for the user to discover via a Shopify-side error later.

**Auto-push each page as soon as it validates clean** — don't wait until every page in the whole
build is done:
```
node scripts/push-theme.js <store> <themeId> templates/<page>.json
```
(pass every file that page's work actually touched, e.g. also `sections/header-group.json` if that
page's pass configured it too). If the push errors, or the merchant-visible result is wrong, fix it
immediately — re-run `apply-section.js`/re-patch, re-validate, re-push — before starting the next
page. Never move on with a page left in a known-broken state "to fix later."

### 7. Report

For each page: a short table of section → real file used, then a clearly separated "needs merchant
follow-up" list (missing images/products/collections/videos, placeholder copy the design didn't
show, anything flagged-not-auto-resolved). Don't bury these in prose — they're the actual action
items for whoever reviews the build.

## Known real mistakes from past sessions (why the rules above exist)

- Picked `email-signup-banner.liquid` for a homepage newsletter section without checking
  `enabled_on`/`disabled_on` — it's password-page-only, broke on push. → always check §4.2.
- Guessed built-in preset icon names (`award`, `check-mark`, ...) instead of exporting the real
  Figma vector for a `custom_icon` (SVG) field, even though the export tool was available the whole
  time. → always check §5's icon rule.
- Set a heading/breadcrumb alignment to "left" because the individual TEXT node's `font.align` said
  "LEFT", when the actual centered block (measured via parent-box gaps) was dead-center. → always do
  the box-gap math in §5, never trust `font.align` alone for block-level alignment.
- Wrote `""` into `product_list`/`collection_list`-type fields (Shopify requires an array) — passed
  local checks silently because `sanitizeSection` only checked range/richtext/select at the time;
  this has since been fixed in `src/shopify/validate-section.js` to check every real schema type,
  but always run `validate-template-types.js` anyway — it catches anything the write-time
  auto-correct still can't infer a safe fix for.
- Picked `product-attribute-table.liquid` for a static ingredient name/description table — the real
  schema needs actual Shopify product/metafield references per block, not free text; the design
  needed `product-specifications.liquid` instead, whose blocks are real free-text rows. → always
  read the CANDIDATE file's actual block settings (§4.3) before assuming a plausible-sounding file
  fits.
- Read the ENTIRE `main-product.liquid` file (15,000+ lines, ~200K tokens in one subagent call) just
  to configure a handful of blocks a design actually used out of its ~35 available types. →
  `read-section-schema.js` now exists specifically to avoid this: always do the Figma-analysis-first,
  index-then-detail flow in §5, never `read-theme-file.js` a `sections/*.liquid` file just to see its
  schema.
- (Fixed 2026-07-20) `src/shopify/validate-section.js`'s `snapValue()` had no case for schema
  `"type": "number"` (a real, distinct Shopify type — free numeric input, no min/max/step, used e.g.
  by `announcement`'s `end_year`) — it fell through to the generic string catch-all, which treats
  any non-string as "a number that slipped into a string-only field" and resets it to `""`. Writing
  a real number (e.g. `end_year: 2026`) into a `number` field via `apply-section.js` silently
  corrupted it to an empty string, which passed `validate-template-types.js` too (that script had
  the identical gap — only `range` was checked for being numeric) and only surfaced as a real
  `shopify theme push` failure ("Setting 'end_year' must be a valid number") — reported 3 times
  before being root-caused. Both files now handle `number` explicitly (clamped/coerced like `range`,
  minus the min/max/step). → whenever a section schema has a field typed `"number"` (grep the raw
  `.liquid` file for `"type": "number"` — don't assume "range" is the only numeric type), verify
  after writing that `validate-template-types.js` actually still reports the real value type by
  spot-checking the written JSON directly — a clean validator run is not proof if the validator
  itself has a blind spot for that type.
- (Fixed 2026-07-20, `figma-decorative-pruning-bug`) `src/figma/fetch-figma.js`'s decorative-prune
  heuristic used to fire on ANY container node with no TEXT/IMAGE found in `out.children` — but at a
  capped `depth`, `out.children` is only a partial view, so real content sitting deeper than the
  requested depth looked identical to a genuinely empty icon and got silently deleted. This is what
  caused whole real pages/sections/blocks/icons (confirmed on a live file: three full mobile page
  frames, a popup's own heading/body/CTA copy, an entire header hamburger-menu flyout) to vanish
  during ordinary depth-2-to-4 discovery scans. Fixed by only applying the prune on unlimited-depth
  fetches; a capped-depth fetch now sets `needsDeeperFetch: true` instead and keeps whatever partial
  children it has. → never trust a `decorative: true` you see in an OLD cached JSON file fetched
  before this fix landed; re-fetch it. Going forward, always re-fetch any `needsDeeperFetch`-flagged
  node before concluding it has nothing to configure (see the `figma-fetch-node.js` bullet above).
- Mobile header/menu icon (hamburger) is not a real Figma-driven config target — it renders by
  default on mobile regardless of settings; any header-group "icon style" field only affects
  desktop. Don't go looking for a "show hamburger on mobile" field to set from a mobile mockup — the
  only real content inside a mobile menu flyout is the actual link labels (→ Shopify navigation
  linklist, not a section setting) and anything unrelated to icon/open-close behavior.

## Making sure both viewports and all block/icon detail actually get read

Two failure modes to guard against explicitly, now that the pruning bug above is fixed:

1. **Missing a whole viewport.** At step 1, once `Template` is found, explicitly enumerate ALL of
   its direct children (a depth-2/3 scan is enough — real content will now correctly surface via
   `needsDeeperFetch` rather than vanishing) and look for both a `Desktop Layout`-shaped group/frame
   set AND a `Mobile Layout`-shaped one, independently — don't stop looking the moment you find one.
   If a file only ever contains one (as confirmed by fully expanding every top-level child, not by a
   shallow scan going quiet), that's a legitimate single-viewport file — say so explicitly per the
   existing viewport rule in §1, but only after actually confirming absence, not just an
   un-re-fetched `needsDeeperFetch` stub.
2. **Missing block/icon detail on an otherwise-found section.** Any `needsDeeperFetch: true` (or,
   on pre-fix cached JSON, `decorative: true`) on a node whose box size is clearly bigger than an
   icon (rule of thumb: bigger than roughly 60×60px) is almost certainly real content, not
   decoration — always re-fetch that exact node with `figma-fetch-node.js "<url-with-that-node-id>"`
   and NO depth argument (full depth; per-section full-depth reads are cheap) before finalizing a
   section's fields or its custom-icon export. Only trust a `decorative: true` produced by an
   unlimited-depth fetch of the section itself (step 5's normal flow already does this).
