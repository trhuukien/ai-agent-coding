const { pullTheme, getThemeDir, readLocalFile } = require('../shopify/cli');
const { ensureRepo, commitAll, stageAll, diffCached } = require('../shopify/git');
const { runFigmaColorSync } = require('../ai/agents/workflow-figma-colors');
const { runWorkflowE } = require('../ai/agents/workflow-e');
const { SECTION_FILES } = require('./store');

const GENERAL_CONFIG_FILE = 'config/settings_data.json';

function sectionKeyFor(key) {
  return key === 'general' ? GENERAL_CONFIG_FILE : SECTION_FILES[key];
}

function buildTemplateTask(file, figmaUrl, prompt, correction) {
  let task = `Configure the page template file "${file}" so it matches this Figma design exactly: ${figmaUrl}

This is the ONLY template you should modify in this task — do not touch any other templates/*.json file.`;

  if (prompt) {
    task += `\n\nAdditional instructions from the developer — apply these too:\n${prompt}`;
  }
  if (correction) {
    task += `\n\nThe developer reviewed your previous result and asked for this correction. Read the CURRENT content of "${file}" first, then re-check it against the Figma design and fix accordingly:\n${correction}`;
  }
  return task;
}

async function runSection(store, themeId, sectionKey, section, correction, storePassword, onProgress) {
  const log = (msg) => { if (onProgress) onProgress(msg); };

  if (sectionKey === 'general') {
    log('[general] Syncing general colors from Figma...');
    const instructions = [section.prompt, correction].filter(Boolean).join('\n\n');
    return runFigmaColorSync(store, themeId, section.figmaUrl, instructions || null, storePassword, onProgress);
  }

  const file = SECTION_FILES[sectionKey];
  log(`[${file}] Configuring from Figma...`);
  const task = buildTemplateTask(file, section.figmaUrl, section.prompt, correction);
  return runWorkflowE(store, themeId, task, storePassword, [], onProgress);
}

async function buildProject(project, storePassword = null, onProgress = null) {
  const { store, themeId } = project;
  const themeDir = getThemeDir(store, themeId);
  const log = (msg) => { if (onProgress) onProgress(msg); };

  log('[pull] Pulling theme from Shopify...');
  await pullTheme(store, themeId);

  log('[git] Committing pulled baseline...');
  await ensureRepo(themeDir);
  await commitAll(themeDir, 'baseline: pulled from Shopify');

  const changedFiles = [];
  const summaries = [];

  for (const sectionKey of ['general', 'home', 'product', 'collection']) {
    const section = project.sections?.[sectionKey];
    if (!section?.figmaUrl) continue;

    const result = await runSection(store, themeId, sectionKey, section, null, storePassword, onProgress);
    changedFiles.push(...result.changedFiles);
    if (result.summary) summaries.push(`[${sectionKey}]\n${result.summary}`);
  }

  log('[git] Staging changes for diff...');
  await stageAll(themeDir);

  const uniqueKeys = [...new Set(changedFiles.map((f) => f.key))];
  const diffs = [];
  for (const key of uniqueKeys) {
    const diffText = await diffCached(themeDir, key);
    if (!diffText) continue; // AI wrote the file but content ended up identical — nothing to review
    diffs.push({
      key,
      diff: diffText,
      after: readLocalFile(store, themeId, key),
      reasons: changedFiles.filter((f) => f.key === key).map((f) => f.reason).filter(Boolean),
    });
  }

  return { diffs, summary: summaries.join('\n\n') };
}

// Re-runs ONE section with a developer correction and returns just that section's updated diff.
async function reviseSection(project, sectionKey, correction, storePassword = null, onProgress = null) {
  const { store, themeId } = project;
  const themeDir = getThemeDir(store, themeId);
  const section = project.sections?.[sectionKey];
  if (!section?.figmaUrl) throw new Error(`Section "${sectionKey}" has no Figma link configured`);

  const result = await runSection(store, themeId, sectionKey, section, correction, storePassword, onProgress);

  await stageAll(themeDir);
  const key = sectionKeyFor(sectionKey);
  const diffText = await diffCached(themeDir, key);

  return {
    key,
    diff: diffText || '(không có thay đổi so với lần trước)',
    after: readLocalFile(store, themeId, key),
    reasons: result.changedFiles.filter((f) => f.key === key).map((f) => f.reason).filter(Boolean),
    summary: result.summary,
  };
}

module.exports = { buildProject, reviseSection };
