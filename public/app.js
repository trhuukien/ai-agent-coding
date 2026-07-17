const SECTIONS = [
  { key: 'general', label: 'General config', hint: 'Màu sắc tổng quát của theme (config/settings_data.json)' },
  { key: 'home', label: 'Home page', hint: 'templates/index.json' },
  { key: 'product', label: 'Product page', hint: 'templates/product.json' },
  { key: 'collection', label: 'Collection page', hint: 'templates/collection.json' },
];

// ─── New project form ───────────────────────────────────────────────────────

const sectionsFields = document.getElementById('sections-fields');

function renderSectionFields() {
  sectionsFields.innerHTML = SECTIONS.map((s) => `
    <div class="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50" data-section="${s.key}">
      <div class="flex items-baseline justify-between">
        <p class="text-sm font-medium text-slate-700">${s.label}</p>
        <p class="text-[11px] text-slate-400 font-mono">${s.hint}</p>
      </div>
      <input class="sec-figma w-full rounded-md border border-slate-300 text-xs px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
             placeholder="Link Figma..." />
      <textarea class="sec-prompt w-full rounded-md border border-slate-300 text-xs px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                rows="2" placeholder="Prompt hướng dẫn (tuỳ chọn) — vd: chỉ đổi phần hero, giữ nguyên phần đánh giá sản phẩm"></textarea>
    </div>
  `).join('');
}
renderSectionFields();

function readSectionFields() {
  const sections = {};
  sectionsFields.querySelectorAll('[data-section]').forEach((block) => {
    const key = block.dataset.section;
    sections[key] = {
      figmaUrl: block.querySelector('.sec-figma').value.trim(),
      prompt: block.querySelector('.sec-prompt').value.trim(),
    };
  });
  return sections;
}

const form = document.getElementById('project-form');
const formError = document.getElementById('form-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.classList.add('hidden');

  const fd = new FormData(form);
  const body = {
    name: fd.get('name')?.trim() || undefined,
    themeEditorUrl: fd.get('themeEditorUrl')?.trim(),
    sections: readSectionFields(),
  };

  try {
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Lỗi không xác định');

    form.reset();
    renderSectionFields();
    await loadProjects();
  } catch (err) {
    formError.textContent = err.message;
    formError.classList.remove('hidden');
  }
});

// ─── Projects list + build/review ──────────────────────────────────────────

const projectsList = document.getElementById('projects-list');
document.getElementById('refresh-projects').addEventListener('click', loadProjects);

// per-project client-side state: last build job + edited file contents
const projectState = new Map();

async function loadProjects() {
  const resp = await fetch('/api/projects');
  const projects = await resp.json();
  projectsList.innerHTML = '';
  if (projects.length === 0) {
    projectsList.innerHTML = '<p class="text-sm text-slate-500">Chưa có project nào. Tạo project ở bên trái.</p>';
    return;
  }
  for (const project of projects) {
    if (!projectState.has(project.id)) projectState.set(project.id, { buildJob: null, edits: {} });
    projectsList.appendChild(renderProjectCard(project));
  }
}

function sectionBadges(project) {
  return SECTIONS
    .filter((s) => project.sections?.[s.key]?.figmaUrl)
    .map((s) => `<span class="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-600 text-xs px-2 py-0.5">${s.label}</span>`)
    .join('');
}

function renderProjectCard(project) {
  const card = document.createElement('div');
  card.className = 'bg-white rounded-xl shadow-sm border border-slate-200 p-5';
  card.innerHTML = `
    <div class="flex items-start justify-between gap-4">
      <div>
        <h3 class="font-semibold text-slate-800">${project.name}</h3>
        <p class="text-xs text-slate-500 mt-0.5">${project.store} · theme ${project.themeId}</p>
        <div class="flex flex-wrap gap-1.5 mt-2">${sectionBadges(project)}</div>
      </div>
      <div class="flex gap-2 flex-shrink-0">
        <a class="preview-link text-xs font-medium text-slate-500 hover:text-slate-800 rounded-lg px-2 py-2"
           href="https://${project.store}/?preview_theme_id=${project.themeId}" target="_blank" rel="noopener">Xem preview ↗</a>
        <button class="btn-build bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium rounded-lg px-3 py-2">Build</button>
        <button class="btn-delete text-slate-400 hover:text-red-600 text-xs px-2">Xoá</button>
      </div>
    </div>
    <div class="build-area mt-4"></div>
  `;

  card.querySelector('.btn-delete').addEventListener('click', async () => {
    if (!confirm(`Xoá project "${project.name}"?`)) return;
    await fetch(`/api/projects/${project.id}`, { method: 'DELETE' });
    await loadProjects();
  });

  card.querySelector('.btn-build').addEventListener('click', () => startBuild(project, card));

  return card;
}

async function startBuild(project, card) {
  const state = projectState.get(project.id);
  state.edits = {};
  const buildArea = card.querySelector('.build-area');
  buildArea.innerHTML = `
    <div class="border-t border-slate-100 pt-3">
      <p class="text-xs font-medium text-slate-500 mb-1">Đang build...</p>
      <pre class="build-log text-xs bg-slate-900 text-slate-100 rounded-lg p-3 max-h-40 overflow-auto"></pre>
    </div>
  `;
  const logEl = buildArea.querySelector('.build-log');

  const resp = await fetch(`/api/projects/${project.id}/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await resp.json();
  if (!resp.ok) {
    logEl.textContent = `Lỗi: ${data.error}`;
    return;
  }

  pollJob(data.jobId, {
    onTick: (job) => { logEl.textContent = (job.log || []).join('\n'); logEl.scrollTop = logEl.scrollHeight; },
    onDone: (job) => {
      state.buildJob = job;
      renderBuildResult(project, card, job);
    },
    onError: (job) => {
      buildArea.innerHTML = `<div class="border-t border-slate-100 pt-3"><p class="text-sm text-red-600">Lỗi build: ${job.error || job.message || 'unknown'}</p></div>`;
    },
  });
}

function renderBuildResult(project, card, job) {
  const buildArea = card.querySelector('.build-area');
  const diffs = job.result?.diffs || [];

  if (diffs.length === 0) {
    buildArea.innerHTML = `<div class="border-t border-slate-100 pt-3"><p class="text-sm text-slate-500">Không có file nào thay đổi.</p></div>`;
    return;
  }

  buildArea.innerHTML = `
    <div class="border-t border-slate-100 pt-3 space-y-3">
      <p class="text-xs font-medium text-slate-500">${diffs.length} file đã sửa — xem preview, yêu cầu sửa nếu sai, rồi apply:</p>
      <div class="diff-list space-y-3"></div>
      <div class="apply-status text-sm"></div>
      <button class="btn-apply w-full bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg px-4 py-2.5">
        Apply (push lên Shopify)
      </button>
    </div>
  `;

  const diffList = buildArea.querySelector('.diff-list');
  diffs.forEach((diff) => diffList.appendChild(renderDiffCard(project, card, diff)));

  buildArea.querySelector('.btn-apply').addEventListener('click', () => applyBuild(project, card));
}

function sectionKeyForFile(key) {
  if (key === 'config/settings_data.json') return 'general';
  if (key === 'templates/index.json') return 'home';
  if (key === 'templates/product.json') return 'product';
  if (key === 'templates/collection.json') return 'collection';
  return null;
}

function renderDiffLine(line) {
  let cls = 'text-slate-500';
  if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-slate-400';
  else if (line.startsWith('+')) cls = 'text-emerald-700 bg-emerald-50';
  else if (line.startsWith('-')) cls = 'text-red-700 bg-red-50';
  else if (line.startsWith('@@')) cls = 'text-sky-600';
  return `<div class="${cls} px-3 whitespace-pre">${escapeHtml(line) || '&nbsp;'}</div>`;
}

function renderDiffCard(project, card, diff) {
  const state = projectState.get(project.id);
  const sectionKey = sectionKeyForFile(diff.key);
  const wrapper = document.createElement('details');
  wrapper.className = 'border border-slate-200 rounded-lg overflow-hidden';
  wrapper.dataset.key = diff.key;
  wrapper.open = true;

  const diffLines = diff.diff.split('\n').filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ''));

  wrapper.innerHTML = `
    <summary class="cursor-pointer bg-slate-50 px-3 py-2 text-xs font-mono font-medium text-slate-700 flex items-center justify-between">
      <span>${diff.key}</span>
      ${diff.reasons?.length ? `<span class="text-slate-400 font-sans font-normal">${escapeHtml(diff.reasons[diff.reasons.length - 1])}</span>` : ''}
    </summary>
    <pre class="diff-view text-xs bg-white max-h-72 overflow-auto py-2 leading-5">${diffLines.map(renderDiffLine).join('')}</pre>
    <details class="edit-section border-t border-slate-100">
      <summary class="cursor-pointer text-xs text-indigo-600 px-3 py-1.5 bg-slate-50">Sửa nội dung file trước khi apply</summary>
      <textarea class="after-editor w-full text-xs px-3 py-2 min-h-[12rem] max-h-96 focus:outline-none" spellcheck="false">${escapeHtml(diff.after ?? '')}</textarea>
    </details>
    ${sectionKey ? `
    <div class="revise-section border-t border-slate-100 px-3 py-2 space-y-1.5 bg-amber-50/40">
      <p class="text-xs font-medium text-slate-600">Sai chỗ nào? Mô tả để AI sửa lại đúng phần này:</p>
      <textarea class="revise-input w-full text-xs rounded-md border border-slate-300 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-500"
                rows="2" placeholder="VD: nút 'Explore Now' đang căn giữa, Figma là căn trái"></textarea>
      <div class="revise-status text-xs"></div>
      <button class="btn-revise text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-md px-3 py-1.5">Yêu cầu sửa lại</button>
    </div>` : ''}
  `;

  wrapper.querySelector('.after-editor').addEventListener('input', (e) => {
    if (e.target.value !== diff.after) {
      state.edits[diff.key] = e.target.value;
    } else {
      delete state.edits[diff.key];
    }
  });

  const reviseBtn = wrapper.querySelector('.btn-revise');
  if (reviseBtn) {
    reviseBtn.addEventListener('click', () => requestRevision(project, card, wrapper, sectionKey));
  }

  return wrapper;
}

async function requestRevision(project, card, diffCard, sectionKey) {
  const state = projectState.get(project.id);
  const input = diffCard.querySelector('.revise-input');
  const statusEl = diffCard.querySelector('.revise-status');
  const btn = diffCard.querySelector('.btn-revise');
  const instruction = input.value.trim();
  if (!instruction) return;

  btn.disabled = true;
  btn.textContent = 'Đang sửa...';
  statusEl.textContent = '';

  const resp = await fetch(`/api/projects/${project.id}/revise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: state.buildJob.jobId || state.buildJob.id, section: sectionKey, instruction }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    statusEl.innerHTML = `<span class="text-red-600">${data.error}</span>`;
    btn.disabled = false;
    btn.textContent = 'Yêu cầu sửa lại';
    return;
  }

  pollJob(data.jobId, {
    onTick: () => {},
    onDone: (job) => {
      const newDiff = job.result.diff;
      delete state.edits[newDiff.key]; // discard any stale manual edit, superseded by the revision
      const replacement = renderDiffCard(project, card, newDiff);
      diffCard.replaceWith(replacement);
    },
    onError: (job) => {
      statusEl.innerHTML = `<span class="text-red-600">Lỗi: ${job.error || job.message || 'unknown'}</span>`;
      btn.disabled = false;
      btn.textContent = 'Yêu cầu sửa lại';
    },
  });
}

async function applyBuild(project, card) {
  const state = projectState.get(project.id);
  const statusEl = card.querySelector('.apply-status');
  const btn = card.querySelector('.btn-apply');
  btn.disabled = true;
  btn.textContent = 'Đang apply...';
  statusEl.textContent = '';

  const resp = await fetch(`/api/projects/${project.id}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: state.buildJob.jobId || state.buildJob.id, edits: state.edits }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    statusEl.innerHTML = `<span class="text-red-600">Lỗi: ${data.error}</span>`;
    btn.disabled = false;
    btn.textContent = 'Apply (push lên Shopify)';
    return;
  }

  pollJob(data.jobId, {
    onTick: () => {},
    onDone: (job) => {
      statusEl.innerHTML = `<span class="text-emerald-600">✓ Đã push ${job.result.pushed.length} file lên Shopify.</span>`;
      btn.textContent = 'Đã apply';
    },
    onError: (job) => {
      statusEl.innerHTML = `<span class="text-red-600">Lỗi push: ${job.error || job.message || 'unknown'}</span>`;
      btn.disabled = false;
      btn.textContent = 'Apply (push lên Shopify)';
    },
  });
}

// ─── Job polling helper ─────────────────────────────────────────────────────

function pollJob(jobId, { onTick, onDone, onError }) {
  const interval = setInterval(async () => {
    const resp = await fetch(`/api/jobs/${jobId}`);
    const job = await resp.json();
    job.jobId = jobId;
    if (job.status === 'running') {
      onTick(job);
      return;
    }
    clearInterval(interval);
    if (job.status === 'done') onDone(job);
    else onError(job);
  }, 1500);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Init ────────────────────────────────────────────────────────────────

loadProjects();
