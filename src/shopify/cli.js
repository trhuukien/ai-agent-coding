const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Local folder name always uses the bare store handle (e.g. "kizchann"), never the full
// "<handle>.myshopify.com" domain — the domain is still what's passed to the real `shopify`
// CLI's --store flag (pullTheme/pushFiles below), this only affects where files live on disk.
function toHandle(store) {
  return store.replace(/\.myshopify\.com$/, '');
}

function getThemeDir(store, themeId) {
  return path.join(process.cwd(), 'theme', toHandle(store), themeId);
}

class AuthRequiredError extends Error {
  constructor(userCode, authUrl) {
    super('AUTH_REQUIRED');
    this.name = 'AuthRequiredError';
    this.userCode = userCode;
    this.authUrl = authUrl;
  }
}

function parseAuthPrompt(text) {
  const codeMatch = text.match(/User verification code[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/);
  const urlMatch = text.match(/https:\/\/accounts\.shopify\.com\/activate-with-code[^\s]+/);
  if (codeMatch && urlMatch) {
    return { userCode: codeMatch[1], authUrl: urlMatch[0] };
  }
  return null;
}

function runCLI(args, { timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('shopify', args, {
      shell: true,
      env: { ...process.env, SHOPIFY_FLAG_NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';

    const checkAuth = (chunk) => {
      const text = stdout + stderr;
      const auth = parseAuthPrompt(text);
      if (auth) {
        proc.kill();
        reject(new AuthRequiredError(auth.userCode, auth.authUrl));
      }
    };

    proc.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); checkAuth(); });
    proc.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); checkAuth(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('CLI command timed out'));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else if (!(stderr + stdout).includes('activate-with-code')) {
        reject(new Error(`shopify CLI exited ${code}: ${stderr}`));
      }
    });
  });
}

function getPassword(store) {
  try {
    const configPath = path.join(process.cwd(), 'stores.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.stores[store]?.password || null;
  } catch {
    return null;
  }
}

async function pullTheme(store, themeId) {
  const themeDir = getThemeDir(store, themeId);
  fs.mkdirSync(themeDir, { recursive: true });

  const args = ['theme', 'pull', '--store', store, '--theme', themeId, '--path', `"${themeDir}"`, '--force'];
  const password = getPassword(store);
  if (password) args.push('--password', password);

  await runCLI(args);

  console.log(`Pulled → theme/${toHandle(store)}/${themeId}/`);
  return themeDir;
}

async function pushFiles(store, themeId, keys) {
  const themeDir = getThemeDir(store, themeId);

  const args = ['theme', 'push', '--store', store, '--theme', themeId, '--path', `"${themeDir}"`, '--only', ...keys, '--allow-live'];
  const password = getPassword(store);
  if (password) args.push('--password', password);

  await runCLI(args);
}

function listLocalFiles(store, themeId) {
  const themeDir = getThemeDir(store, themeId);
  if (!fs.existsSync(themeDir)) return [];

  const files = [];
  function walk(dir, base = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        files.push({ key: rel, size: fs.statSync(path.join(dir, entry.name)).size });
      }
    }
  }
  walk(themeDir);
  return files;
}

function readLocalFile(store, themeId, key) {
  const filePath = path.join(getThemeDir(store, themeId), key);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function writeLocalFile(store, themeId, key, content) {
  const filePath = path.join(getThemeDir(store, themeId), key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function searchInTheme(store, themeId, pattern, maxResults = 20) {
  const themeDir = getThemeDir(store, themeId);
  if (!fs.existsSync(themeDir)) return [];

  const results = [];
  const regex = new RegExp(pattern, 'gi');

  function walk(dir, base = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= maxResults) return;
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (/\.(liquid|json|js|css)$/.test(entry.name)) {
        const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
        const lines = content.split('\n');
        lines.forEach((line, i) => {
          if (results.length >= maxResults) return;
          if (regex.test(line)) {
            regex.lastIndex = 0;
            results.push({ file: rel, line: i + 1, match: line.trim().slice(0, 120) });
          }
        });
      }
    }
  }

  walk(themeDir);
  return results;
}

module.exports = { pullTheme, pushFiles, listLocalFiles, readLocalFile, writeLocalFile, searchInTheme, getThemeDir, AuthRequiredError };
