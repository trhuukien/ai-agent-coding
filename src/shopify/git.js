const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

async function ensureRepo(themeDir) {
  if (!fs.existsSync(path.join(themeDir, '.git'))) {
    await run(themeDir, ['init', '-q']);
    await run(themeDir, ['config', 'user.email', 'ai-support-theme@local']);
    await run(themeDir, ['config', 'user.name', 'AI Support Theme']);
  }
}

// Stages everything and commits. No-op (does not throw) if there is nothing to commit.
async function commitAll(themeDir, message) {
  await run(themeDir, ['add', '-A']);
  try {
    await run(themeDir, ['commit', '-q', '-m', message]);
  } catch (err) {
    if (!/nothing to commit/i.test(err.stdout || err.stderr || err.message)) throw err;
  }
}

// Stages everything (so new/untracked files show up) without committing — used right
// before diffing so `git diff --cached` reflects the latest write_theme_file calls.
async function stageAll(themeDir) {
  await run(themeDir, ['add', '-A']);
}

async function diffCached(themeDir, key) {
  return run(themeDir, ['diff', '--cached', '--no-color', '--', key]);
}

async function changedKeysCached(themeDir) {
  const out = await run(themeDir, ['diff', '--cached', '--name-only']);
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

module.exports = { ensureRepo, commitAll, stageAll, diffCached, changedKeysCached };
