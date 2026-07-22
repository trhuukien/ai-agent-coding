# Changelog / lessons learned

Full history behind the terse rules in `CLAUDE.md`'s "Known real mistakes" list — not auto-loaded
into every session's context like `CLAUDE.md` is, so read this on demand when you want the "why"
behind a rule, not by default.

## Fixed bugs

### 2026-07-20 — `number` schema type silently corrupted to `""`

`src/shopify/validate-section.js`'s `snapValue()` had no case for schema `"type": "number"` (a
real, distinct Shopify type — free numeric input, no min/max/step, used e.g. by `announcement`'s
`end_year`). It fell through to the generic string catch-all, which treats any non-string as "a
number that slipped into a string-only field" and resets it to `""`. Writing a real number (e.g.
`end_year: 2026`) into a `number` field via `apply-section.js` silently corrupted it to an empty
string, which passed `validate-template-types.js` too (that script had the identical gap — only
`range` was checked for being numeric) and only surfaced as a real `shopify theme push` failure
("Setting 'end_year' must be a valid number") — reported 3 times before being root-caused.

Both files now handle `number` explicitly (clamped/coerced like `range`, minus the min/max/step).

**Rule that exists because of this** (see CLAUDE.md §5): whenever a section schema has a field
typed `"number"` (grep the raw `.liquid` file for `"type": "number"` — don't assume "range" is the
only numeric type), verify after writing that `validate-template-types.js` actually still reports
the real value type by spot-checking the written JSON directly — a clean validator run is not proof
if the validator itself has a blind spot for that type.

### 2026-07-20 — Figma decorative-pruning bug (`figma-decorative-pruning-bug`)

`src/figma/fetch-figma.js`'s decorative-prune heuristic used to fire on ANY container node with no
TEXT/IMAGE found in `out.children` — but at a capped `depth`, `out.children` is only a partial
view, so real content sitting deeper than the requested depth looked identical to a genuinely empty
icon and got silently deleted. Confirmed on a live file: three full mobile page frames, a popup's
own heading/body/CTA copy, and an entire header hamburger-menu flyout all vanished during ordinary
depth-2-to-4 discovery scans this way.

Fixed by only applying the prune on unlimited-depth fetches; a capped-depth fetch now sets
`needsDeeperFetch: true` instead and keeps whatever partial children it has.

**Rule that exists because of this** (see CLAUDE.md's `figma-fetch-node.js` bullet): never trust a
`decorative: true` you see in an OLD cached JSON file fetched before this fix landed — re-fetch it.
Any `needsDeeperFetch: true` (or old `decorative: true`) on a node whose box is clearly bigger than
an icon (rule of thumb: bigger than ~60×60px) is almost certainly real content — re-fetch that exact
node at full depth before concluding it has nothing to configure.

## Other real mistakes from past sessions (not code bugs — judgment errors, still worth avoiding)

- Picked `email-signup-banner.liquid` for a homepage newsletter section without checking
  `enabled_on`/`disabled_on` — it's password-page-only, broke on push.
- Guessed built-in preset icon names (`award`, `check-mark`, ...) instead of exporting the real
  Figma vector for a `custom_icon` (SVG) field, even though the export tool was available the whole
  time.
- Set a heading/breadcrumb alignment to "left" because the individual TEXT node's `font.align` said
  "LEFT", when the actual centered block (measured via parent-box gaps) was dead-center.
- Wrote `""` into `product_list`/`collection_list`-type fields (Shopify requires an array) — passed
  local checks silently because `sanitizeSection` only checked range/richtext/select at the time;
  fixed in `src/shopify/validate-section.js` to check every real schema type.
- Picked `product-attribute-table.liquid` for a static ingredient name/description table — the real
  schema needs actual Shopify product/metafield references per block, not free text; the design
  needed `product-specifications.liquid` instead, whose blocks are real free-text rows.
- Read the ENTIRE `main-product.liquid` file (15,000+ lines, ~200K tokens in one subagent call) just
  to configure a handful of blocks a design actually used out of its ~35 available types —
  `read-section-schema.js`'s two-phase index-then-detail flow exists specifically to avoid this.
- Mobile header/menu icon (hamburger) is not a real Figma-driven config target — it renders by
  default on mobile regardless of settings; any header-group "icon style" field only affects
  desktop. The only real content inside a mobile menu flyout is the actual link labels (→ Shopify
  navigation linklist, not a section setting) and anything unrelated to icon/open-close behavior.

## Token-cost investigation (2026-07-20)

A single 3-page theme build (General Config + Header/Footer/Overlay + 22 page sections via parallel
subagents) measured at ~1.75M tokens summed across the 22 subagents alone, likely ~2.2-2.5M total
including orchestrator overhead and retried/interrupted agents — found to exceed a Pro plan's
per-task budget. Root causes identified and partially fixed:

1. **Schema re-read redundancy**: every icon-picker `select` field repeats the same ~80-option
   preset list verbatim — measured 26% of one real section's phase-2 schema payload. Fixed:
   `read-section-schema.js` now compresses this to a short note (see CLAUDE.md). Also drops
   `header`/`paragraph` doc-only entries (no `id`, never writable). Measured 61% size reduction on
   `main-product`'s schema with zero field-id loss.
2. **Pretty-printed JSON overhead**: every Figma/schema fetch script was outputting 2-space indented
   JSON meant for human terminal reading, but these outputs are only ever read by Claude (directly
   or via a file an agent Reads) — indentation is pure whitespace with zero information value.
   Fixed: `figma-fetch-node.js`, `figma-fetch-multi.js`, `read-section-schema.js`,
   `read-settings-current.js` now output minified JSON. Measured 63-72% size reduction, byte-identical
   after `JSON.parse` either way.
3. **Not yet fixed** (architectural, not script-level): 22 separate subagents each re-read schema/
   Figma data independently even when several share identical content (e.g. 3x "Email signup" with
   byte-identical text across pages); a single subagent's own conversation carries its early tool
   results (Figma JSON, schema) through every remaining turn, multiplying their effective cost by
   however many turns remain; 3 of 22 subagents were interrupted mid-task and had to be fully
   re-dispatched from scratch, wasting their partial work entirely. These would need either
   consolidating near-duplicate sections into fewer agent dispatches, pre-fetching shared schema
   once at the orchestrator level instead of per-agent, or restructuring section configuration as a
   multi-stage pipeline (separate short-lived agent per stage) so large early reads don't ride along
   through a long tail of later turns.

## New capabilities added (2026-07-20)

- `figma-fetch-image.js` — renders real PNG screenshots of Figma nodes (not just JSON), added after
  repeated alignment/carousel/column-count mistakes from JSON-only inference. See CLAUDE.md for
  workflow integration (step 1 discovery cross-check, step 5 per-section visual reference).
- `fetch-shopify-collections.js` — fetches a store's real collection list via the storefront's
  public `/collections.json` endpoint (with storefront-password bypass support), so `collection`
  reference fields can be matched against real data instead of always left blank. Verified against
  a real password-protected store and a real live store on a custom domain. See CLAUDE.md for the
  matching-confidence rule and the "don't mix collection data across different stores" gotcha (hit
  once during testing — a collection handle only resolves within the same store it came from).
