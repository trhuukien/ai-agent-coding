require('dotenv').config();
// build.js's runSection/buildTemplateTask are not exported (private helpers), so this replicates
// their exact logic inline rather than modifying build.js's export surface just for this run —
// the call into runWorkflowE below is byte-for-byte what runSection('product', ...) would produce.
const { runWorkflowE } = require(process.cwd() + '/src/ai/agents/workflow-e');

const store = 'kizchann.myshopify.com';
const themeId = '189914972524';
const file = 'templates/product.json';
const figmaUrl = 'https://www.figma.com/design/IA58UAk52ou0WBcjEKS1Kg/FC---114?node-id=22212-90783';

const task = `Configure the page template file "${file}" so it matches this Figma design exactly: ${figmaUrl}

This is the ONLY template you should modify in this task — do not touch any other templates/*.json file.`;

function onProgress(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

runWorkflowE(store, themeId, task, null, [], onProgress)
  .then((result) => {
    console.log('\n=== DONE ===');
    console.log('changedFiles:', JSON.stringify(result.changedFiles, null, 2));
    console.log('\n=== SUMMARY ===\n', result.summary);
  })
  .catch((err) => {
    console.error('\n=== FAILED ===');
    console.error(err);
    process.exit(1);
  });
