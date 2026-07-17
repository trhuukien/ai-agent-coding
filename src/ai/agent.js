const Anthropic = require('@anthropic-ai/sdk');
const { classifyTask } = require('./agents/router');
const { runWorkflowA } = require('./agents/workflow-a');
const { runWorkflowB } = require('./agents/workflow-b');
const { runWorkflowC } = require('./agents/workflow-c');
const { runWorkflowD } = require('./agents/workflow-d');
const { runWorkflowE } = require('./agents/workflow-e');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WORKFLOW_RUNNERS = {
  A: runWorkflowA,
  B: runWorkflowB,
  C: runWorkflowC,
  D: runWorkflowD,
  E: runWorkflowE,
};

async function runAgent(store, themeId, task, storePassword = null, images = [], onProgress = null) {
  // Step 1: classify the task with the router agent
  const { workflow, reason } = await classifyTask(anthropic, task, images);
  console.log(`  → Workflow ${workflow}: ${reason}`);
  if (onProgress) onProgress(`[router] Workflow ${workflow}: ${reason}`);

  // Step 2: dispatch to the specialized workflow agent. Figma color-sync (when this store/theme
  // has one configured) is workflow E's own concern — it only makes sense when we're already
  // pulling Figma data to configure pages, so it lives inside runWorkflowE, not here.
  const runner = WORKFLOW_RUNNERS[workflow];
  if (!runner) {
    throw new Error(`Unknown workflow: ${workflow}`);
  }

  const result = await runner(store, themeId, task, storePassword, images, onProgress);
  return { changedFiles: result.changedFiles, summary: result.summary };
}

module.exports = { runAgent };
