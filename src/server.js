require('dotenv').config();
const path = require('path');
const express = require('express');
const { pushFiles, writeLocalFile, getThemeDir, AuthRequiredError } = require('./shopify/cli');
const { commitAll } = require('./shopify/git');
const { listProjects, getProject, createProject, updateProject, deleteProject, SECTION_KEYS } = require('./projects/store');
const { buildProject, reviseSection } = require('./projects/build');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const jobs = new Map();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ─── Projects (Figma-driven build) ─────────────────────────────────────────
// This is the ONLY build path this server exposes: create a project (store + themeId + a Figma
// link per page/general-config), then /build it. There is no generic free-text "do X to this
// theme" endpoint — see CLAUDE.md for the alternative (Claude Code session) mode, which has no
// server/API-key dependency at all.

app.get('/api/projects', (req, res) => {
  res.json(listProjects());
});

app.post('/api/projects', (req, res) => {
  try {
    const project = createProject(req.body);
    res.status(201).json(project);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/projects/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
  try {
    const project = updateProject(req.params.id, req.body);
    res.json(project);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', (req, res) => {
  deleteProject(req.params.id);
  res.status(204).end();
});

// Build → pulls theme, syncs general colors, configures each template from its Figma link.
// Does NOT push — returns diffs for review. 202 async, poll via /api/jobs/:jobId.
app.post('/api/projects/:id/build', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { storePassword } = req.body || {};
  const jobId = `build-${project.id}-${Date.now()}`;
  const log = [];

  jobs.set(jobId, { type: 'project-build', projectId: project.id, status: 'running', log, startedAt: new Date() });

  buildProject(project, storePassword || null, (msg) => log.push(msg))
    .then((result) => {
      jobs.set(jobId, { ...jobs.get(jobId), status: 'done', result });
      console.log(`[${jobId}] Build done ✓ (${result.diffs.length} file(s) changed)`);
    })
    .catch((err) => {
      if (err instanceof AuthRequiredError) {
        jobs.set(jobId, {
          ...jobs.get(jobId),
          status: 'needs_auth',
          auth: { userCode: err.userCode, authUrl: err.authUrl },
          message: `Open the link to authenticate this store once, then retry.`,
        });
      } else {
        jobs.set(jobId, { ...jobs.get(jobId), status: 'error', error: err.message });
        console.error(`[${jobId}] Build error:`, err.message);
      }
    });

  res.status(202).json({ jobId, status: 'running', pollUrl: `/api/jobs/${jobId}` });
});

// Revise → re-runs ONE section (general/home/product/collection) with a developer correction,
// then merges its updated diff back into the original build job so Apply picks up the fix.
app.post('/api/projects/:id/revise', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { jobId: buildJobId, section, instruction, storePassword } = req.body || {};
  const buildJob = jobs.get(buildJobId);
  if (!buildJob || buildJob.type !== 'project-build' || buildJob.projectId !== project.id) {
    return res.status(400).json({ error: 'Invalid or missing build jobId for this project' });
  }
  if (buildJob.status !== 'done') {
    return res.status(400).json({ error: `Build job is not finished (status: ${buildJob.status})` });
  }
  if (!SECTION_KEYS.includes(section)) {
    return res.status(400).json({ error: `Unknown section: ${section}` });
  }
  if (!instruction || !instruction.trim()) {
    return res.status(400).json({ error: 'instruction is required' });
  }

  const reviseJobId = `revise-${project.id}-${Date.now()}`;
  const log = [];
  jobs.set(reviseJobId, { type: 'project-revise', projectId: project.id, buildJobId, section, status: 'running', log, startedAt: new Date() });

  reviseSection(project, section, instruction, storePassword || null, (msg) => log.push(msg))
    .then((diff) => {
      // merge into the original build job's diffs so Apply pushes the corrected version
      const diffs = buildJob.result.diffs.filter((d) => d.key !== diff.key);
      diffs.push(diff);
      buildJob.result.diffs = diffs;

      jobs.set(reviseJobId, { ...jobs.get(reviseJobId), status: 'done', result: { diff } });
    })
    .catch((err) => {
      if (err instanceof AuthRequiredError) {
        jobs.set(reviseJobId, {
          ...jobs.get(reviseJobId),
          status: 'needs_auth',
          auth: { userCode: err.userCode, authUrl: err.authUrl },
        });
      } else {
        jobs.set(reviseJobId, { ...jobs.get(reviseJobId), status: 'error', error: err.message });
      }
    });

  res.status(202).json({ jobId: reviseJobId, status: 'running', pollUrl: `/api/jobs/${reviseJobId}` });
});

// Apply → writes any dev edits over the build's diffs, then pushes those files to Shopify.
app.post('/api/projects/:id/apply', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { jobId: buildJobId, edits } = req.body || {};
  const buildJob = jobs.get(buildJobId);
  if (!buildJob || buildJob.type !== 'project-build' || buildJob.projectId !== project.id) {
    return res.status(400).json({ error: 'Invalid or missing build jobId for this project' });
  }
  if (buildJob.status !== 'done') {
    return res.status(400).json({ error: `Build job is not finished (status: ${buildJob.status})` });
  }

  const keys = buildJob.result.diffs.map((d) => d.key);
  for (const [key, content] of Object.entries(edits || {})) {
    if (!keys.includes(key)) continue; // ignore edits for files outside this build
    writeLocalFile(project.store, project.themeId, key, content);
  }

  if (keys.length === 0) {
    return res.json({ pushed: [] });
  }

  const applyJobId = `apply-${project.id}-${Date.now()}`;
  jobs.set(applyJobId, { type: 'project-apply', projectId: project.id, status: 'running', startedAt: new Date() });

  pushFiles(project.store, project.themeId, keys)
    .then(() => commitAll(getThemeDir(project.store, project.themeId), `applied via UI: ${keys.join(', ')}`))
    .then(() => {
      jobs.set(applyJobId, { ...jobs.get(applyJobId), status: 'done', result: { pushed: keys } });
      console.log(`[${applyJobId}] Applied ✓ (${keys.length} file(s) pushed)`);
    })
    .catch((err) => {
      if (err instanceof AuthRequiredError) {
        jobs.set(applyJobId, {
          ...jobs.get(applyJobId),
          status: 'needs_auth',
          auth: { userCode: err.userCode, authUrl: err.authUrl },
        });
      } else {
        jobs.set(applyJobId, { ...jobs.get(applyJobId), status: 'error', error: err.message });
      }
    });

  res.status(202).json({ jobId: applyJobId, status: 'running', pollUrl: `/api/jobs/${applyJobId}` });
});

// Poll job status
app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// List recent jobs
app.get('/api/jobs', (req, res) => {
  const all = [...jobs.entries()]
    .map(([jobId, job]) => ({ jobId, type: job.type, store: job.store, status: job.status, startedAt: job.startedAt }))
    .reverse();
  res.json(all);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nAI Support Theme → http://localhost:${PORT}\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      'Warning: ANTHROPIC_API_KEY is not set — this server (API key mode) can\'t run a project\n' +
      'build/revise, those calls will fail. Either set ANTHROPIC_API_KEY in .env, or skip this\n' +
      'server entirely and use Claude session mode instead: open this repo in a Claude Code\n' +
      'session and follow CLAUDE.md, no API key or server required.\n'
    );
  }
});
