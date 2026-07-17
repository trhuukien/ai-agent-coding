const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(process.cwd(), 'projects.json');

const SECTION_KEYS = ['general', 'home', 'product', 'collection'];

// Section → the template file it configures. "general" has no template file —
// it drives config/settings_data.json instead (see workflow-figma-colors.js).
const SECTION_FILES = {
  home: 'templates/index.json',
  product: 'templates/product.json',
  collection: 'templates/collection.json',
};

function parseThemeEditorUrl(url) {
  const match = url.match(/admin\.shopify\.com\/store\/([^/]+)\/themes\/(\d+)/);
  if (!match) {
    throw new Error('Not a valid Shopify theme editor URL (expected .../store/<handle>/themes/<id>/editor)');
  }
  const [, handle, themeId] = match;
  return { store: `${handle}.myshopify.com`, themeId };
}

function normalizeSections(sections) {
  const out = {};
  for (const key of SECTION_KEYS) {
    const s = (sections && sections[key]) || {};
    out[key] = {
      figmaUrl: (s.figmaUrl || '').trim(),
      prompt: (s.prompt || '').trim(),
    };
  }
  return out;
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { projects: {} };
  }
}

function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function listProjects() {
  const db = load();
  return Object.values(db.projects);
}

function getProject(id) {
  const db = load();
  return db.projects[id] || null;
}

function createProject({ name, themeEditorUrl, sections }) {
  const { store, themeId } = parseThemeEditorUrl(themeEditorUrl);

  const db = load();
  const id = `proj_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const now = new Date().toISOString();

  const project = {
    id,
    name: name || `${store} / ${themeId}`,
    store,
    themeId,
    themeEditorUrl,
    sections: normalizeSections(sections),
    createdAt: now,
    updatedAt: now,
  };

  db.projects[id] = project;
  save(db);
  return project;
}

function updateProject(id, updates) {
  const db = load();
  const existing = db.projects[id];
  if (!existing) throw new Error(`Project not found: ${id}`);

  const merged = { ...existing };

  if (updates.name != null) merged.name = updates.name;
  if (updates.themeEditorUrl) {
    const { store, themeId } = parseThemeEditorUrl(updates.themeEditorUrl);
    merged.themeEditorUrl = updates.themeEditorUrl;
    merged.store = store;
    merged.themeId = themeId;
  }
  if (updates.sections) {
    merged.sections = normalizeSections({ ...existing.sections, ...updates.sections });
  }

  merged.updatedAt = new Date().toISOString();
  db.projects[id] = merged;
  save(db);
  return merged;
}

function deleteProject(id) {
  const db = load();
  delete db.projects[id];
  save(db);
}

module.exports = {
  SECTION_KEYS,
  SECTION_FILES,
  parseThemeEditorUrl,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
};
