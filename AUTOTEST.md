# AI Support Theme — Auto-test (FE verification) playbook

**This file is a SEPARATE, independent task from `SETUP.md`'s Auto-setup playbook.** Both are read on
demand from `CLAUDE.md` — the file Claude Code auto-loads into every session regardless of task,
kept minimal for exactly that reason (see `CLAUDE.md` itself). Auto-setup builds/reconfigures a
theme's pages from Figma; Auto-test verifies an ALREADY-EXISTING theme (built by this project, or by
anyone else — it makes no difference) against its Figma design and logs the results to the team's
tracking spreadsheet. Auto-test never writes section config and never calls `apply-section.js` — it
only screenshots, compares, and reports. Don't run `SETUP.md`'s build steps for a message that
triggers this file, and don't run this file's steps for a message that triggers `SETUP.md`.

## Trigger

The user will send something shaped like:

```
Test: https://admin.shopify.com/store/<handle>/themes/<themeId>/editor
Figma: https://www.figma.com/design/<fileKey>/<name>?node-id=...
```

or with a bare store domain (including a custom domain, e.g. `elianaluxury.com`, not just
`<handle>.myshopify.com`) and a numeric theme id spelled out directly, sometimes with a storefront
password on the same or a follow-up message. Recognize the intent (verb "Test" + a Figma URL + a
store/theme reference) rather than matching one exact template — store/theme identification follows
the same rules as `SETUP.md`'s Trigger section (`parseThemeEditorUrl` for admin editor URLs; ask
before guessing if genuinely ambiguous).

Which SPREADSHEET (the Google Sheets file itself) to log into: **check `GOOGLE_SHEETS_TRACKING_ID`
in `.env` FIRST, before anything else** — this is the durable, cross-session, cross-machine answer
(a conversation's own memory of "already used earlier" does NOT survive into a fresh session/machine,
`.env` does). If the user names a different one, or one was already used earlier in this same
conversation, that overrides `.env` for this run. If `.env` has no value AND none is known any other
way, don't ask yet either — **CONFIRMED REAL LIMITATION: the Service Account cannot create a
brand-new standalone spreadsheet from scratch** (`spreadsheets.create` fails with "The caller does
not have permission" — same root cause as the Drive-upload quota block below: no personal storage
of its own). So there is no "auto-create the file" option; the only spreadsheet a Service Account
can act on is one a real Google account has already shared with it (Editor). The one real exception
where you DO need to ask: if truly no spreadsheet has EVER been shared with this Service Account in
this project before (a one-time, first-ever setup gap, not a recurring question) — ask then, and
**write the answer straight into `GOOGLE_SHEETS_TRACKING_ID` in `.env`** so no future session (this
machine) ever has to ask again; once any spreadsheet is known, every later round reuses it
automatically, see "Sheet
format" below for what changes per round (a new TAB, never a new file).

## Prerequisites (check once, at the very start)

1. `FIGMA_ACCESS_TOKEN` in `.env` — same check as `SETUP.md`.
2. Playwright installed: `npx playwright install chromium` (one-time; `playwright` itself is
   already a project dependency). If a screenshot script fails with a browser-launch error before
   anything else, this is the first thing to check.
3. **Only if logging to a Google Sheet is requested** (the normal case): `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`
   in `.env`, pointing at a Google Cloud Service Account JSON key with the Sheets API (and, only if
   image embedding is wanted AND the account has Google Workspace, the Drive API) enabled on that
   key's GCP project. The target spreadsheet must be shared with that service account's own email
   (Editor). See "Logging results" below for what this key can and can't do.

## Scripts used (all in `scripts/`, all read `.env` themselves)

- `figma-fetch-node.js` / `figma-fetch-multi.js` / `figma-fetch-image.js` — same tools `SETUP.md`
  uses for discovery/config; reused here to discover the Figma file's real page/section structure
  and render each section's design image. See `SETUP.md`'s own entries for full usage — not
  duplicated here.
- `screenshot-theme-page.js <store> <themeId> <path> <out-dir> [password] [sectionKeys] [viewport]`
  — renders a theme's LIVE/preview page in a real headless browser (Playwright) and screenshots it
  section-by-section (matched via Shopify's own `[id^="shopify-section-"]` wrapper), one PNG per
  section — the live-side counterpart to `figma-fetch-image.js`. Uses `?preview_theme_id=<themeId>`
  on the public storefront domain — confirmed working unauthenticated (no staff login needed).
  `store` accepts a bare handle, a full `.myshopify.com` domain, OR a custom domain
  (`elianaluxury.com`) — anything containing a `.` is used exactly as given, never suffixed.
  Password uses the same one-off-arg convention as `fetch-shopify-collections.js` (never stored).
  Optional `sectionKeys` (comma-separated, using the FULL printed key e.g.
  `template--xxx__hero`, not a partial name) screenshots only those specific sections — pass `""`
  to skip this and still reach `viewport`. Optional `viewport` (`"WIDTHxHEIGHT"`, e.g. `"390x844"`)
  — MUST match whatever viewport the Figma design actually is (mobile-only Figma files are a
  confirmed real case — check the Figma frame's own `box.width` before assuming desktop); defaults
  to `1440x900` when omitted. This script already handles, unconditionally, every real gotcha found
  building it (see "Known real gotchas" below) — don't re-solve these per project, they're baked in:
  hidden password toggle, non-standard submit button, IntersectionObserver-gated content, cookie
  banners, Shopify's own preview-bar/sticky-header bleeding into unrelated sections.
- `check-computed-style.js <store> <themeId> <path> <checksJsonFile> [password] [viewport]` — reads
  the LIVE page's real `getComputedStyle(...)` for a small, targeted list of `{sectionKey,
  selector, property, expected, tolerancePx}` checks — `color`, `background-color`, `font-size`,
  `font-weight`, `padding-top`/`padding-bottom` (compared by numeric/color value), or
  `font-style`/`text-transform`/`text-decoration-line` (compared as an exact keyword string, e.g.
  `italic` vs `normal` — never run through numeric comparison). Deterministic, no model call,
  effectively free. `selector: ""` targets the section wrapper itself (`[id*="sectionKey"]`) — for a
  section-level padding check, confirm THIS is actually the padded element on the theme under test
  before relying on it; on at least one real theme the true padding lives on an inner
  `.section-padding-<sectionKey>`-classed element instead, and the outer wrapper always reads 0/0
  regardless of real config (see step 4 and the matching gotcha below — pass that class explicitly as
  `selector` when this applies). **YOU compute every `expected` value ahead of time** — a hex color
  from the theme's real `settings_data.json`, a resolved px number, or (most often, since Auto-test
  usually has no local config to read) the real `font.family`/`font.weight`/italic flag read
  straight off the already-fetched Figma TEXT node — this script only compares, it never derives a
  `%` scale, a token name, or a font weight/style itself. Never guess an expected value from a
  screenshot; if you don't have real source data for a property, skip checking it rather than
  inventing an expected value.
- `log-to-sheet.js <spreadsheetId> <sheetName> <rowsJsonFile>` — appends rows via the Sheets API
  using the Service Account. **GOTCHA (confirmed real, cost a header row once): don't rely on this
  for anything past the very first write to a brand-new, fully empty tab.** The Sheets API's
  `values.append` finds "the next row after the last CONTIGUOUS non-empty row" from its anchor — it
  stops at the first genuinely blank row and does not look further down for real content past it.
  On a sheet whose layout has a title row, a blank spacer row, THEN a header row (the team's actual
  convention — see "Sheet format" below), append sees only the title row as "the table" and starts
  overwriting at the blank spacer, destroying the header and every row after it. **Always write the
  header block and the data rows with explicit `values.update` ranges (`A1:G3`, `A4:F31`, etc.)
  computed by you from the known row count — never `append` onto a sheet that has any structure
  above the data.**
- `format-test-sheet.js <spreadsheetId> <sheetName> <dataRowCount>` — applies the team's real visual
  format (read once from the `[FC148] AI Testing` tab via the Sheets API, not guessed): a merged
  white title cell + merged green round/theme cell across rows 1-2, a green bold-white column-header
  row 3, and a `ONE_OF_LIST` dropdown (`PASS`/`Reopen`/`Review`/`Note for SA`/`Skip`/`Tester done
  setup` — this is the team's real, fixed vocabulary; **never write `FAIL` or invent a status value
  outside this list**, map any layout/style mismatch to `Reopen`) on BOTH the `AI Test` and
  `Review Test` columns, plus matching conditional-format background colors on each. Run this once,
  after all data rows are written.
- `embed-images-in-sheet.js <spreadsheetId> <sheetName> <mappingJsonFile>` — uploads local PNGs via
  the Drive API and writes `=IMAGE(url)` formulas into the given cells. **CONFIRMED BLOCKED on a
  plain personal Gmail account**: Service Accounts have no Drive storage quota of their own (Google
  disabled this) — uploading only works into a Shared Drive (needs Google Workspace) or via
  domain-wide delegation. Don't attempt this script until you've confirmed the user actually has
  Workspace/Shared-Drive access; on a personal account (the common case), use
  `build-verify-gallery.js` below instead, every time, without re-discovering the blocker first.
- `build-verify-gallery.js <dataJsonFile> <outHtmlFile>` — the real image-logging path for the
  common (no-Workspace) case: builds a single self-contained HTML gallery (sticky Status+Page
  filter bar, one row per section with Figma alongside EVERY round's live screenshot so far —
  `Figma | Round 1 | Round 2 | ...`, most-recent-round notes shown first) from a JSON data blob (see
  the script's own header comment for the exact shape: `sections[].rounds[]`, each round carrying
  its own `aiStatus`/`reviewStatus`/`note`/`live` image — see "Sheet format" below for what these
  mean). This published Artifact IS the durable, portable store for round history (see "Round
  history" below) — publish it once per store/Figma pairing and keep republishing the SAME file
  path/URL every round, never a new one.

## Step-by-step

### 0. Round history — check BEFORE deciding what to test

Before doing any real work, find out if this store/Figma pairing has been tested before:
1. Find the sheet tab (`[store_name] AI Testing`, see "Logging results" below). If it exists, read
   its title row (row 1) for an existing gallery Artifact URL (put there by a prior round — see
   "Logging results").
2. If a gallery URL is found: `WebFetch` it and parse the embedded
   `<script type="application/json" id="gallery-data">...</script>` blob — this is the SAME JSON
   structure `build-verify-gallery.js` consumes (`sections[].rounds[]`), so it's already exactly
   the data you need, no reformatting. This gives you, per section: its Figma image (reusable,
   unchanged since the design didn't change), and every prior round's `aiStatus`/`reviewStatus`/
   `note`/live image.
3. **Determine scope from this using the EFFECTIVE status** (`reviewStatus` if a human tester set
   one, else `aiStatus` — a human correction always wins over the AI's own original verdict): any
   section whose LATEST round has an effective status of `Reopen` is what you re-test this round.
   Sections that were already `PASS` (or `Review`/`Note for SA`/etc.) do NOT need to be re-tested by
   default — carry their existing round history forward unchanged into the merged data, don't waste
   a fresh screenshot+comparison on something already resolved. (If the user explicitly asks for a
   full re-test of everything regardless of prior status, that overrides this default — but don't
   assume that's wanted just because a round exists.)
4. If no gallery URL is found (first-ever round for this store/Figma pairing, or the sheet tab is
   brand new): test everything, as a normal round 1.

This is what makes a round genuinely incremental instead of redoing full-page work every time —
steps 1-4 below then only need to run for the sections identified in this step, not the whole page.

### 1. Discover what to test

Identify the real page/section structure of the Figma file being tested against, the same
discovery discipline as `SETUP.md` step 1 (root canvas at shallow depth, find `Template`/pages,
confirm real names) — but lighter: you need each section's node id (to fetch its image) and rough
content, not full field-level schema detail (Auto-test never writes config, so schema reads are
usually unnecessary — only pull a section's schema if you need to know a real field id for a
computed-style check).

**Check the Figma frame's own `box.width` before doing anything else with viewports.** A
mobile-only file (frames ~320-480px wide, no separate desktop frame anywhere) is a confirmed real
case — if you assume desktop and screenshot the live site at 1440px, every layout comparison will
be comparing two different, non-corresponding renders. Whatever width Figma actually is, pass the
matching `viewport` to every `screenshot-theme-page.js`/`check-computed-style.js` call for this
round.

### 2. Render Figma section images + screenshot the live site

Batch-render every section's Figma image via `figma-fetch-image.js` (split into multiple smaller
batch calls — e.g. ~10 nodes per call — if a single large batch call 500s; this is a real,
observed transient Figma API failure, just retry that one batch).

Screenshot each real page (home, a real product page, a real collection page — use
`fetch-shopify-collections.js`/a real `/products.json` fetch to get real handles, the same
never-guess discipline as `SETUP.md`) via `screenshot-theme-page.js`, matching viewport. Header/
mega-menu needs the same special handling `SETUP.md` step 5's icon/header rules already describe
for static vs interactive state — screenshot-theme-page.js's automatic sticky-hide only solves
sections BLEEDING INTO each other, it doesn't reveal an interactive dropdown; still hover/click that
yourself when you specifically need the mega-menu's own content.

### 3. Layout check (vision, narrow-scoped)

Pair each live section screenshot with its Figma render and dispatch a lightweight reviewer
subagent asking about layout facts — column count, block order/sequence, alignment, carousel vs
static — AND about component-level structure: does the live render use the SAME kind of UI element
in the same places (same badge style/type, same breadcrumb separator glyph, same number of visually
distinct background zones/bands within the section), even where the exact colors/wording differ.
Cross-page duplicate sections (the same design reused on 2+ pages) only need one comparison pass,
same dedup discipline as `SETUP.md` step 3.

**"Ignore color and text" means ignore exact hex shades and exact word choice — it does NOT mean
ignore a different component entirely.** Confirmed real misses from this exact instruction being
read too broadly: a badge showing "NEW" (Figma, one style) vs "NEW ARRIVAL"/"SOLD OUT" (live, two
different styles depending on stock) is a real structural difference, not a color/text nuance — so
is a breadcrumb using `_` in Figma vs `>` on live, and a banner with two distinct background bands
in Figma rendering as one flat background live. All three were marked PASS once because the vision
check was told to ignore "color and text" and applied that too literally. When prompting the
reviewer subagent, be explicit: flag ANY case where a different-looking component, separator, badge
style, or number of distinct visual zones appears, even if the specific hex/wording is out of scope.

**Any section whose live screenshot looks suspiciously blank should be re-verified before being
logged as a failure.** Confirmed real cause, not a one-off: content gated behind
IntersectionObserver-driven reveal (Alpine.js `x-intersect`, common for a lazy map embed or a
fade-in heading) can still look blank even after `screenshot-theme-page.js`'s own scroll+wait if the
specific page needed a longer settle time — before writing "section missing/blank" into the report,
re-run the screenshot for just that section (`sectionKeys` arg) and actually look at the result.

### 4. Computed-style check (code-only, MANDATORY per section — not optional spot-checking)

**Confirmed real gap: leaving color entirely to the vision pass in step 3 let a real background
mismatch through undetected** (a section with two distinct background bands in Figma rendered as one
flat background live — vision was told to ignore "color" and skipped it entirely, no other check
ever looked at it). Color must be verified deterministically, not left to vision noticing it or not.

For EVERY section (not just ones flagged ambiguous), run at minimum:
- `background-color` of the section's own wrapper, and of ANY visually distinct sub-zone within it
  (e.g. a breadcrumb strip sitting on a different background band than the heading above it) —
  expected value pulled from that Figma node's real `fills` array, not guessed.
- For any heading/key text: `color`, `font-weight`, `font-size` — expected values from the real
  Figma TEXT node's `font.family`/`font.weight`/`font.size` and fill color, same source data
  `SETUP.md`'s own config-time work already uses, already fetched during step 2.
- **Section-level `padding-top`/`padding-bottom`** — expected values from that Figma section frame's
  own real auto-layout `padding {top, bottom}` property (ground truth, not box-gap math). **Before
  trusting an empty `selector` for this check, confirm which live element actually carries the
  padding on THIS theme** — see the confirmed gotcha in `check-computed-style.js`'s own header
  comment: on at least one real theme the outer `[id*="sectionKey"]` wrapper always reads 0/0
  regardless of real config, because the actual padding lives on an inner
  `.section-padding-<sectionKey>`-classed element instead. **A padding mismatch is INFO-ONLY, never
  by itself a reason to mark a section `Reopen`** — write it into the test note as a factual
  measurement, but don't fail the section for it. (User's explicit call: a live theme's own small
  default section spacing differing from Figma's exact `0`/flush intent is common, low-priority, and
  not worth blocking on — only escalate to `Reopen` if the user separately confirms it should.)
- **Item spacing / gap** between repeated blocks inside a section (product cards, collection tiles,
  logo rows, blog cards, FAQ rows, etc.) — expected value from the Figma frame's own auto-layout
  `itemSpacing` property. No dedicated script call for this one: measure it generically by finding
  the shallowest container with ≥2 visibly-sized children and reading the pixel gap between the
  first two (via `getBoundingClientRect()` on adjacent siblings, in a `page.evaluate`) — this works
  well for a plain repeated-block grid/list, but is UNRELIABLE for image/carousel/marquee-shaped
  sections (a CSS-animated ticker, an `image-with-text` layout, a video carousel with its own slide
  margins) where it tends to land on the wrong DOM pair and reads a false near-zero gap — see the
  matching gotcha below for the exact reliability rule (trust it only when the detected container's
  class name plausibly matches a real item-repeating wrapper). **Unlike padding, a confirmed real gap
  mismatch (reliable container, real measured difference) DOES count as a genuine `Reopen`-worthy
  finding** — it's a distinct, deterministic layout defect the vision pass in step 3 cannot reliably
  see, not a minor spacing nitpick.

Run color/font/background checks through `check-computed-style.js` against the live render —
deterministic PASS/FAIL, no guessing. A finding here (e.g. rendered font-size consistently smaller
than Figma across multiple unrelated sections) is strong evidence of a sitewide config value (a
`heading_base_size`-style setting) being off, not a per-section bug — say so explicitly rather than
reporting each occurrence as an unrelated one-off. If you don't have the theme's actual
`settings_data.json` to confirm which side is "right" (Figma vs the site's own intentional scale),
say that plainly instead of asserting a confirmed bug. **If a font-size (or any other selector-list
based) check reads back a suspiciously large deviation repeated identically across multiple
sections, treat that as a signal to double-check the check script's own selector construction before
reporting a sitewide bug** — see the `check-computed-style.js` selector-scoping gotcha below; that
exact failure mode (a `"h2, h3"`-style selector list only partially scoped) produced a false
"~15px vs Figma's 22px" finding in an earlier round that was purely a measurement bug.

### 5. Fix loop (bounded, only when the user has asked for fixes — not by default)

Auto-test's default job is to REPORT, not to fix — only enter this loop if asked to. For a real,
confirmed mismatch: check first whether it's actually a known merchant follow-up (missing product/
collection/image) rather than a bug. For a genuine fix, dispatch one subagent per section with the
flagged issue + Figma data + current section JSON, get back a `settings`/`blocks` patch (same
fenced-JSON contract as `SETUP.md`'s own subagents — never let it call `apply-section.js` itself),
apply it yourself, re-validate, re-push, re-verify. Cap at 2 attempts per section; still broken after
that, log it as an open item, don't loop forever.

### 6. Logging results

**Sheet format** (read from the team's real `[FC148] AI Testing` tab, this is not an invented
convention): row 1 = title block (left cell: task/design links, merged 2 rows × cols A-D; right
cell: `Round N` + theme preview URL **+ the gallery Artifact link** — see below, merged 2 rows ×
cols E-F/G, green background); row 2 = blank spacer (part of the same merge); row 3 = column
headers `No | Page/Sections | (merged B:D) | | AI Test | Review Test | Note`, green background,
bold white text; row 4+ = one data row per section tested (`No` sequential, `Page` only filled on
that page's first row, blank for subsequent rows in the same page group, `Section`/`Sub-section`
split across 2 columns when useful e.g. `Typography` / `Body`).

**`AI Test` vs `Review Test` (user's explicit convention, confirmed 2026-08-03): two separate status
columns, same fixed vocabulary, not one.** `AI Test` (column E) is what THIS script writes — the
verdict Auto-test itself determined. `Review Test` (column F) is left BLANK by the script, every
round — it exists solely for a human tester to fill in if they want to override the AI's verdict
(e.g. the AI said `Reopen` but a human decides it's actually fine, or vice versa). Never write
anything into `Review Test` yourself; it is not yours to fill.

**Note is a SINGLE column (column G), not a `Test note`/`Reopen note` pair.** Write it in
**Vietnamese** (the team's real working language for this field — confirmed from existing populated
tabs like `[kizchann] AI Testing`, not a new requirement). **Leave it completely EMPTY when `AI
Test` is `PASS`** — a dev scanning the sheet should only see prose where there is something to
actually act on, never a "matches Figma exactly" confirmation cluttering the view. When the status
is `Reopen`/`Review`/etc., write one concise note covering both what's wrong AND (if there's a clear
fix) what to do about it — merge what used to be two separate notes into one dev-facing paragraph,
don't pad it with the full measurement log.

**Rounds are separate column blocks, never overwritten.** If this spreadsheet/tab already has a
prior round's results, a new round adds its OWN `AI Test`/`Review Test`/`Note` column triple to
the right (with its own `Round N` header above them) — it must NEVER overwrite an existing round's
columns. (This project's own history: an early session did overwrite round 1 by mistake before this
rule was written down — don't repeat that.)

Steps, in order:
1. If the target tab doesn't exist yet, create it (`spreadsheets.batchUpdate` with `addSheet`) —
   name it after the STORE being tested, `[store_name] AI Testing` (e.g. `[elianaluxury] AI
   Testing`), not the Figma file code — one store may get tested against several different Figma
   rounds over time, all logged into the same per-store tab (as new round column-blocks, see
   above), so the store name is the stable identity, not whichever Figma file happened to be
   current that round.
2. Write the title/header rows via explicit `values.update` (never `append` — see the gotcha above).
3. Write all data rows via explicit `values.update` to a computed range (`A4:F{3+rowCount}`).
4. Run `format-test-sheet.js` to apply the real visual format + Status dropdown.
5. **Image logging — check Drive/Workspace availability once BEFORE attempting `embed-images-in-sheet.js`.**
   If the user confirms Workspace/Shared-Drive access, that script's upload + `=IMAGE()` formulas
   are fine to use directly. On a plain personal Gmail account (the common case), it WILL fail —
   don't attempt it a second time once already confirmed blocked in this session. The real path for
   this case is `build-verify-gallery.js`:
   a. Take the merged data from step 0 (prior rounds' untouched sections + this round's freshly
      tested sections appended as a new entry in their `rounds[]` array) and write it to a JSON file
      matching the script's input shape.
      - **Compress live screenshots before embedding** (e.g. via `sharp`, JPEG quality ~65-70, max
        width ~420px for a mobile capture) to keep the whole page a few MB, not tens of MB. **Always
        `.flatten({ background: '#ffffff' })` before JPEG conversion** — a transparent Figma PNG
        silently turns BLACK under JPEG's default flatten otherwise, a confirmed real bug. Figma
        images only need compressing once each round they're actually re-fetched; images already
        carried over from a prior round (via the WebFetch-and-parse in step 0) are already
        compressed base64 strings, reuse them as-is, don't recompress.
   b. Run `build-verify-gallery.js` to produce the HTML.
   c. Publish it as an Artifact. **If a gallery already existed for this store/Figma pairing (step
      0 found one), republish to that SAME file path** so the URL stays identical — the sheet's
      existing link then keeps working with no update needed. Only a genuinely first-ever round
      needs the link written into the sheet for the first time.
   d. **Link it from the sheet's title row (row 1) ONLY — never as its own column.** User's explicit
      call (2026-08-03): don't create a dedicated "Figma"/"Gallery" column repeating the same URL on
      every data row; it's redundant clutter once the link is already in the header. Fold it into
      the same `Round N` title-row cell that already carries the theme preview URL (see "Sheet
      format" above) — one line added to that cell's existing multi-line text, not a new formula, not
      a new column. Only need to actually WRITE this on the first-ever round; later rounds reuse the
      same URL so the existing header link already points at the right place.
   - **Use a plain auto-linkified URL in that cell, not `HYPERLINK()`.** A `HYPERLINK()` formula
     embedded mid-string inside a multi-line title cell renders as literal, non-clickable formula
     text instead of evaluating — Google Sheets only evaluates a formula when it is the cell's
     ENTIRE content. Since this cell already holds multiple lines of plain text (task links, theme
     URL, scope note), just add the gallery URL as one more plain line — Sheets auto-linkifies any
     bare URL in plain text on its own, no formula needed. (This also sidesteps the `vi_VN`-locale
     `;`-vs-`,` argument-separator gotcha entirely, since there's no formula to write.)

### 7. Report

Summarize per page: section → PASS/Reopen (using the real team vocabulary, never `FAIL`), with the
concrete reason for anything not PASS. Separate: (a) confirmed real issues worth fixing, (b) items
that are actually merchant follow-up / expected-missing-data, not bugs, (c) anything you couldn't
verify with confidence (e.g. a section obscured by a cookie banner you didn't get to re-shoot,
ambiguous naming between a Figma layer and a live section key) — flag these as open, don't guess a
verdict. Give the sheet tab URL/gallery link directly, don't make the user hunt for it.

## Known real gotchas (why the rules above exist)

- **Custom domain handling**: a store argument containing a `.` (a real domain like
  `elianaluxury.com`, not just `*.myshopify.com`) must be used exactly as given — appending
  `.myshopify.com` onto an already-real domain produces a nonexistent host. Fixed in both
  `screenshot-theme-page.js` and `fetch-shopify-collections.js` by checking for ANY `.`, not
  specifically `.myshopify.com`.
- **Password form hidden behind a toggle**: some themes show a newsletter-signup field by default
  on `/password` and only reveal the real password input after clicking "Enter using password" —
  `screenshot-theme-page.js` checks visibility and clicks that toggle first when needed.
- **Password submit button lacks an explicit `type="submit"` attribute**: a bare `<button>` inside a
  form IS submit-type by HTML default, but that default is never reflected as a literal attribute —
  a `button[type="submit"]` CSS selector silently matches nothing on themes that just write
  `<button name="commit">`. Select any `button` inside the password form, not specifically
  `[type="submit"]`.
- **IntersectionObserver-gated content** (Alpine.js `x-intersect`, used to lazy-load a map iframe's
  `src` or fade in text): a single fast full-page pre-scroll can skip past the trigger threshold
  without ever crossing it on an actually-rendered frame, leaving a section that LOOKS completely
  blank even though it's genuinely configured correctly. Fix: scroll each section fully into view
  and pause briefly immediately before ITS OWN screenshot (not just one pass at the start).
- **An iframe's `src` being set (the IntersectionObserver firing) is NOT the same moment as the
  iframe's own remote content finishing its load** — confirmed real false-negative: a Google Maps
  embed's `src` was set correctly within the normal ~400ms wait, but the map TILES themselves took
  ~5 real seconds to render; a screenshot taken at 400ms shows a solid-color placeholder block that
  looks exactly like broken/missing content even though the embed is genuinely configured right. The
  user caught this by checking the live site directly and seeing the real map — always re-verify
  an "empty visual" finding by hand before writing it into a Reopen when the element in question is
  an iframe, and give any section containing an `<iframe>` several extra seconds before capturing
  (`screenshot-theme-page.js` now checks for `el.querySelector('iframe')` and adds a 5s wait).
- **A section's own visual comparison at the ONE viewport Figma provides (this project's designs are
  usually mobile-only, 390px) can miss a real bug that only manifests at a DIFFERENT, unchecked
  viewport.** Confirmed real case: two `image-with-text` PDP sections had `full_width: false` /
  `full_width_mobile: false` in their real config — invisible at 390px (page-width's 1440px max only
  ever constrains a viewport wider than that), but on an actual desktop monitor the image sat boxed
  inside a centered ~1440px column with ~240px of empty space on each side instead of running edge-
  to-edge, a real, user-visible "not full width" bug. The Figma mobile frame's own Video child box
  (`x`/`width` identical to the root page frame, zero inset) is what confirms the DESIGN intent was
  full-bleed even though Figma provides no desktop artwork to compare against — that structural
  Figma signal, not a desktop screenshot, is what makes this checkable even for a mobile-only design.
  When a section's schema has an explicit `full_width`/`full_width_mobile`-shaped boolean, checking
  its live value against this kind of Figma edge-to-edge signal is a cheap, deterministic, worthwhile
  addition — don't assume "we only have a mobile design" means desktop-only bugs are out of scope.
- **Cookie-consent banners obstruct section screenshots**: dismiss common accept/decline/dismiss
  buttons before capturing, or several sections' comparisons become unreliable (partially covered).
- **Shopify's own theme-preview chrome bleeds into section screenshots**: the "Draft" bar
  (`#PBarNextFrameWrapper`) and the platform privacy banner (`#shopify-pc__banner`) are fixed-
  position UI, never real theme content — hide them unconditionally, every capture.
- **A sticky header can visually overlap OTHER sections' screenshots**, and — separately — a sticky
  header wrapper can report a computed height of 0 while its actual visible content still paints
  outside that 0-height box (confirmed real case). `visibility: hidden` does NOT reliably hide such
  a case if inner content resets its own visibility; use `display: none` instead, which removes the
  whole subtree from rendering with no inheritance override possible. `screenshot-theme-page.js`
  detects every sticky/fixed section up front and hides all of them except the one currently being
  captured, using `display: none`.
- **JPEG-compressing a transparent Figma PNG defaults to a BLACK background**, not white — sharp
  (and most image libraries) fill removed alpha with black unless told otherwise. Always
  `.flatten({ background: '#ffffff' })` explicitly before `.jpeg()` when building an image gallery
  from Figma renders.
- **Google Sheets formula argument separator depends on spreadsheet locale**: `vi_VN` (and other
  non-US locales) use `;` between function arguments, not `,` — writing `=HYPERLINK(a, b)` on such a
  sheet produces a silent "Formula parse error" cell. Check `properties.locale` first.
- **A `HYPERLINK()` formula embedded mid-string inside a multi-line cell renders as literal,
  non-clickable text, not a working link** — a Sheets formula only evaluates when it is the cell's
  ENTIRE content. The title-row cell already holds multiple lines of plain text (task links, theme
  URL, scope), so the gallery URL just gets added as one more plain line — Sheets auto-linkifies a
  bare URL in plain text on its own. Don't reach for `HYPERLINK()` for this.
- **Sheet notes are written in Vietnamese, not English** — confirmed real convention from existing
  populated tabs (e.g. `[kizchann] AI Testing`), missed once (2026-08-03, Crystal 3D Pix round 1
  written in English, had to be redone). Check an existing populated tab's language before writing
  the first note, don't assume English just because the rest of this doc/the schemas are in English.
- **`Note` is a single column, empty on PASS — not a `Test note`/`Reopen note` pair, and not a
  running log of confirmations.** A dev scanning the sheet should see prose only where a section
  actually needs attention. And **`AI Test`/`Review Test` are two separate status columns** — the
  script only ever writes `AI Test`; `Review Test` stays blank for a human tester to override the
  verdict, never populate it yourself.
- **`values.append` silently destroys a header row past a blank spacer row** — see `log-to-sheet.js`
  above. Always use explicit `values.update` ranges on any sheet with structure above the data.
- **Service Accounts have no Google Drive storage quota** — `embed-images-in-sheet.js`'s upload step
  fails outright on a plain personal Gmail account (no Shared Drive available). Confirm Workspace/
  Shared-Drive access before attempting it; fall back to the self-contained HTML gallery artifact
  otherwise, every time — don't re-discover this blocker from scratch each round.
- **The team's real Status vocabulary is `PASS`/`Reopen`/`Review`/`Note for SA`/`Skip`/`Tester done
  setup`** — there is no `FAIL` value in their convention. Map any confirmed mismatch to `Reopen`.
- **`WebFetch` on a multi-MB gallery Artifact (many embedded base64 images) can return the raw HTML
  source instead of a model-summarized description** — the underlying summarizer apparently doesn't
  reliably digest a page that's mostly base64 image data. Don't rely on the prompt-based summary for
  this specific use case; the raw HTML IS what you need anyway (to parse out the `#gallery-data`
  JSON blob for step 0's round-history merge), so this is actually fine — just don't be thrown off
  if the "description" you get back is the source itself rather than prose.
- **A Service Account creating a brand-new standalone spreadsheet from scratch also fails**
  (`spreadsheets.create` → "The caller does not have permission") — same root cause as the Drive
  image-upload block (no personal storage of its own). The only spreadsheet a Service Account can
  ever act on is one a real Google account already shared with it (Editor) — there is no "auto-create
  the file" path. If truly no spreadsheet has ever been shared with this Service Account before (a
  one-time gap, not a recurring question), that's the one real case where you still need to ask —
  every later round reuses whatever spreadsheet is already known, no further asking.
- **`check-computed-style.js`'s scoped-selector construction must handle comma-separated selector
  lists per-part, not as one string concatenation.** Confirmed real bug: building the scoped selector
  as `` `[id*="${sectionKey}"] ${selector}` `` when `selector` is itself a list like `"h2, h3"`
  produces `[id*="key"] h2, h3` — a CSS selector LIST where only the first part (`h2`) is actually
  scoped to the section; the second part (`h3`) is silently a page-wide, completely unscoped
  selector, and `page.$()` returns whichever matches first in document order — which can be a
  totally unrelated element on the page. This produced a real false alarm in an earlier round (a
  section's heading font-size read back as ~15px against an expected ~22px, "confirmed" across
  multiple sections) that was actually this bug, not a real site issue — a properly-scoped re-test
  (`sectionEl.querySelector('h2, h3')` via `page.evaluate`, or the now-fixed per-part-prefixed
  selector) showed ~21.6px, matching Figma. Fixed by splitting `selector` on `,` and prefixing EACH
  part individually before rejoining with `,`. Any font-size (or other selector-list-based) finding
  from before this fix should be treated as unverified and re-checked, not trusted at face value.
- **A generic "measure the visual gap between the first two same-row/same-column children" heuristic
  for checking itemSpacing/gap is only moderately reliable, not deterministic-grade.** It works well
  for a plain repeated-block grid/list (product/collection cards, logo rows) where the BFS correctly
  lands on the real item container, but gives false near-zero readings for sections built from
  images/carousels/marquees (a CSS-animated scrolling ticker, an `image-with-text` layout where the
  "first two children" are an image and its own wrapper touching by design, a video-carousel with
  its own internal slide margins) — the heuristic picks a structurally-adjacent-but-wrong pair in
  those cases. Treat a gap heuristic mismatch as trustworthy only when the detected container's own
  class name plausibly matches the real item-repeating wrapper (e.g. a `section-padding-` or
  collection/grid-list class) — a "found: true, gap: 0" on an image/text/carousel-shaped section is
  a strong signal the heuristic picked the wrong DOM node, not a real 0px gap, and should be reported
  as unverified rather than a confirmed finding.
