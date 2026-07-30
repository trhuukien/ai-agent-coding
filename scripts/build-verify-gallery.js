#!/usr/bin/env node
// Build the Auto-test gallery HTML — a self-contained page showing Figma vs LIVE side by side for
// every section tested, across as many rounds as have been run (Figma | Round 1 | Round 2 | ...).
// This is the one durable, portable store for round history: since the Service Account can't
// create Drive files (see AUTOTEST.md), this SAME artifact gets re-fetched (WebFetch), merged with
// new round data, and republished to the SAME URL each round — no local/session-only storage
// needed, works identically on any machine.
//
// Usage:
//   node scripts/build-verify-gallery.js <dataJsonFile> <outHtmlFile>
//
// dataJsonFile shape:
// {
//   "title": "FC-166 Auto-verify — Eliana Luxury",
//   "meta": { "themeUrl": "...", "figmaUrl": "...", "sheetUrl": "...", "sheetTab": "..." },
//   "sections": [
//     {
//       "key": "shop_the_look_hp", "page": "Home page", "section": "Shop the look", "sub": "",
//       "figma": "data:image/jpeg;base64,...",
//       "rounds": [
//         { "round": 1, "status": "Reopen", "testNote": "...", "reopenNote": "...", "live": "data:image/jpeg;base64,..." },
//         { "round": 2, "status": "PASS",   "testNote": "...", "reopenNote": "...", "live": "data:image/jpeg;base64,..." }
//       ]
//     }
//   ]
// }
//
// A section's CARD shows one column per Figma + each round present for it (so different sections
// can have different column counts — a section only re-tested in round 1 shows 2 columns; one
// re-tested through round 3 shows 4). Status/Page filters both operate on the LATEST round's
// status/page per section. Notes are listed per round, most recent first.
const fs = require('fs');

const [, , dataFile, outFile] = process.argv;
if (!dataFile || !outFile) {
  console.error('Usage: node scripts/build-verify-gallery.js <dataJsonFile> <outHtmlFile>');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const { title, meta = {}, sections = [] } = data;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function noteHtml(note) {
  if (!note) return '';
  return esc(note).split('\n').map((l) => `<p>${l}</p>`).join('');
}

const statusClass = (s) => (s || 'PASS').replace(/\s+/g, '');

// Group sections by page, preserving first-seen order.
const pageOrder = [];
const byPage = {};
for (const sec of sections) {
  if (!byPage[sec.page]) {
    byPage[sec.page] = [];
    pageOrder.push(sec.page);
  }
  byPage[sec.page].push(sec);
}

const allStatuses = ['all', 'PASS', 'Reopen', 'Review', 'Note for SA', 'Skip', 'Tester done setup'];
const statusesPresent = new Set(sections.map((s) => (s.rounds[s.rounds.length - 1] || {}).status || 'PASS'));

// Every card gets the SAME number of columns (Figma + 1 per round up to the highest round number
// seen anywhere), so the grid divides evenly across all cards — a section not re-tested in a later
// round just shows a blank placeholder column instead of shrinking that card's column width.
const maxRound = sections.reduce((max, s) => Math.max(max, ...s.rounds.map((r) => r.round), 0), 0);

function sectionCard(sec) {
  const latest = sec.rounds[sec.rounds.length - 1] || {};
  const byRound = new Map(sec.rounds.map((r) => [r.round, r]));
  const cols = [{ label: 'Figma', img: sec.figma, round: null }].concat(
    Array.from({ length: maxRound }, (_, i) => i + 1).map((n) => {
      const r = byRound.get(n);
      return r ? { label: `Round ${n}`, img: r.live, round: r } : { label: `Round ${n}`, img: null, round: null, notTested: true };
    })
  );
  const label = [sec.section, sec.sub].filter(Boolean).join(' — ');

  return `
  <article class="card" data-status="${esc(statusClass(latest.status))}" data-page="${esc(sec.page)}">
    <div class="card-head">
      <span class="section-name">${esc(label)}</span>
      <span class="badge ${esc(statusClass(latest.status))}">${esc(latest.status || 'PASS')}</span>
    </div>
    <div class="imgs" style="grid-template-columns: repeat(${cols.length}, 1fr);">
      ${cols
        .map((c) => {
          const r = c.round;
          const hasNote = r && (r.testNote || r.reopenNote);
          return `
      <div class="imgcol${c.notTested ? ' imgcol-empty' : ''}">
        <div class="lbl">${esc(c.label)}${r ? ` <span class="badge ${esc(statusClass(r.status))}">${esc(r.status || 'PASS')}</span>` : ''}</div>
        ${c.img ? `<img src="${c.img}" loading="lazy" alt="${esc(c.label)} — ${esc(label)}">` : `<div class="no-shot">${c.notTested ? 'không re-test round này' : 'no image'}</div>`}
        ${
          hasNote
            ? `<div class="note-inline">
          ${r.testNote ? `<div class="row"><span class="k">Test note:</span>${noteHtml(r.testNote)}</div>` : ''}
          ${r.reopenNote ? `<div class="row"><span class="k">Reopen note:</span>${noteHtml(r.reopenNote)}</div>` : ''}
        </div>`
            : ''
        }
      </div>`;
        })
        .join('')}
    </div>
  </article>`;
}

const pageGroupsHtml = pageOrder
  .map(
    (page) => `
  <section class="page-group" data-page-group="${esc(page)}">
    <h2 class="page-title">${esc(page)}</h2>
    ${byPage[page].map(sectionCard).join('')}
  </section>`
  )
  .join('');

const statusFilterHtml = allStatuses
  .filter((s) => s === 'all' || statusesPresent.has(s))
  .map((s) => `<button data-filter-type="status" data-f="${esc(s)}" class="${s === 'all' ? 'active' : ''}">${esc(s === 'all' ? 'All' : s)}</button>`)
  .join('');

const pageFilterHtml = ['all', ...pageOrder]
  .map((p) => `<button data-filter-type="page" data-f="${esc(p)}" class="${p === 'all' ? 'active' : ''}">${esc(p === 'all' ? 'All pages' : p)}</button>`)
  .join('');

const html = `<title>${esc(title)}</title>
<style>
:root {
  --bg: #f7f7f5; --card-bg: #ffffff; --text: #1f2320; --muted: #6b7169; --border: #e2e2de;
  --pass: #6a9e58; --pass-bg: #e8f2e3;
  --reopen: #c0524f; --reopen-bg: #fbe9e8;
  --review: #8a5aa8; --review-bg: #f1e6f5;
  --note: #b8862c; --note-bg: #f8ecd6;
  --skip: #7a7a7a; --skip-bg: #eeeeee;
  --done: #4a8b7c; --done-bg: #e2f0ec;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17191b; --card-bg: #212426; --text: #e8e9e6; --muted: #9aa09a; --border: #33362f;
    --pass-bg: #24331e; --reopen-bg: #3a2320; --review-bg: #2e2333; --note-bg: #332a17;
    --skip-bg: #2a2a2a; --done-bg: #1c2e29;
  }
}
:root[data-theme="dark"] {
  --bg: #17191b; --card-bg: #212426; --text: #e8e9e6; --muted: #9aa09a; --border: #33362f;
  --pass-bg: #24331e; --reopen-bg: #3a2320; --review-bg: #2e2333; --note-bg: #332a17;
  --skip-bg: #2a2a2a; --done-bg: #1c2e29;
}
:root[data-theme="light"] {
  --bg: #f7f7f5; --card-bg: #ffffff; --text: #1f2320; --muted: #6b7169; --border: #e2e2de;
  --pass-bg: #e8f2e3; --reopen-bg: #fbe9e8; --review-bg: #f1e6f5; --note-bg: #f8ecd6;
  --skip-bg: #eeeeee; --done-bg: #e2f0ec;
}
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; }
.wrap { max-width: 1280px; margin: 0 auto; padding: 0 16px 60px; }
header.top { padding: 20px 0 4px; }
h1 {
  font-family: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
  font-weight: 400; font-size: 1.5rem; letter-spacing: 0.01em; margin: 0 0 8px; text-wrap: balance;
}
.meta { color: var(--muted); font-size: 0.8rem; line-height: 1.6; word-break: break-all; }
.meta a { color: inherit; text-underline-offset: 2px; }

.filterbar {
  position: sticky; top: 0; z-index: 20;
  background: var(--bg);
  padding: 10px 0 12px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
}
.filter-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.filter-row + .filter-row { margin-top: 6px; }
.filter-row .flabel { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-right: 4px; }
.filterbar button {
  border: 1px solid var(--border); background: var(--card-bg); color: var(--text);
  padding: 5px 12px; border-radius: 999px; font-size: 0.8rem; cursor: pointer;
}
.filterbar button.active { border-color: currentColor; font-weight: 600; }
.filterbar button[data-f="PASS"].active { color: var(--pass); background: var(--pass-bg); }
.filterbar button[data-f="Reopen"].active { color: var(--reopen); background: var(--reopen-bg); }
.filterbar button[data-f="Review"].active { color: var(--review); background: var(--review-bg); }
.filterbar button[data-f="Note for SA"].active { color: var(--note); background: var(--note-bg); }
.filterbar button[data-f="Skip"].active { color: var(--skip); background: var(--skip-bg); }
.filterbar button[data-f="Tester done setup"].active { color: var(--done); background: var(--done-bg); }
.filterbar button[data-f="all"].active { border-color: var(--muted); }

.page-group { margin-bottom: 28px; }
.page-title { font-size: 1.05rem; font-weight: 600; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }

.card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 14px; }
.card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.section-name { font-weight: 600; }
.badge {
  font-size: 0.68rem; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase;
  padding: 3px 9px; border-radius: 999px;
}
.badge.PASS { color: var(--pass); background: var(--pass-bg); }
.badge.Reopen { color: var(--reopen); background: var(--reopen-bg); }
.badge.Review { color: var(--review); background: var(--review-bg); }
.badge.NoteforSA { color: var(--note); background: var(--note-bg); }
.badge.Skip { color: var(--skip); background: var(--skip-bg); }
.badge.Testerdonesetup { color: var(--done); background: var(--done-bg); }

.imgs { display: grid; gap: 10px; align-items: start; }
@media (max-width: 720px) { .imgs { grid-template-columns: 1fr !important; } }
.imgcol { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--bg); display: flex; flex-direction: column; }
.imgcol .lbl { font-size: 0.68rem; color: var(--muted); padding: 4px 8px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 6px; }
.imgcol .lbl .badge { font-size: 0.6rem; padding: 2px 7px; }
.imgcol img { display: block; width: 100%; height: auto; }
.no-shot { padding: 30px 8px; text-align: center; font-size: 0.7rem; color: var(--muted); }
.imgcol-empty { border-style: dashed; opacity: 0.55; }

.note-inline { font-size: 0.8rem; line-height: 1.45; padding: 8px; border-top: 1px solid var(--border); }
.note-inline .row { margin-bottom: 2px; }
.note-inline .row:last-child { margin-bottom: 0; }
.note-inline .row p { margin: 0; }
.note-inline .k { color: var(--muted); font-weight: 600; margin-right: 4px; }

.empty { color: var(--muted); font-style: italic; padding: 20px; text-align: center; }
</style>

<div class="wrap">
  <header class="top">
    <h1>${esc(title)}</h1>
    <div class="meta">
      ${meta.themeUrl ? `Theme: <a href="${esc(meta.themeUrl)}" target="_blank">${esc(meta.themeUrl)}</a><br>` : ''}
      ${meta.figmaUrl ? `Figma: <a href="${esc(meta.figmaUrl)}" target="_blank">${esc(meta.figmaUrl)}</a><br>` : ''}
      ${meta.sheetUrl ? `Sheet: <a href="${esc(meta.sheetUrl)}" target="_blank">${esc(meta.sheetTab || 'sheet')}</a>` : ''}
    </div>
  </header>

  <div class="filterbar">
    <div class="filter-row"><span class="flabel">Status</span>${statusFilterHtml}</div>
    <div class="filter-row"><span class="flabel">Page</span>${pageFilterHtml}</div>
  </div>

  <div id="content">
    ${pageGroupsHtml}
    <div class="empty" id="empty-state" style="display:none;">Không có section nào khớp filter.</div>
  </div>
</div>

<script type="application/json" id="gallery-data">${JSON.stringify(data)}</script>
<script>
  const state = { status: 'all', page: 'all' };
  const cards = Array.from(document.querySelectorAll('.card'));

  function applyFilters() {
    let anyVisible = false;
    cards.forEach((card) => {
      const matchStatus = state.status === 'all' || card.dataset.status === state.status;
      const matchPage = state.page === 'all' || card.dataset.page === state.page;
      const visible = matchStatus && matchPage;
      card.style.display = visible ? '' : 'none';
      if (visible) anyVisible = true;
    });
    document.querySelectorAll('.page-group').forEach((group) => {
      const visible = Array.from(group.querySelectorAll('.card')).some((c) => c.style.display !== 'none');
      group.style.display = visible ? '' : 'none';
    });
    document.getElementById('empty-state').style.display = anyVisible ? 'none' : '';
  }

  document.querySelectorAll('.filterbar button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.filterType;
      document.querySelectorAll('button[data-filter-type="' + type + '"]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state[type] = btn.dataset.f;
      applyFilters();
    });
  });
</script>
`;

fs.writeFileSync(outFile, html);
console.log(`Written ${outFile} (${(html.length / 1024 / 1024).toFixed(2)} MB), ${sections.length} sections across ${pageOrder.length} page groups.`);
