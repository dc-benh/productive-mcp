/**
 * CLI script to fetch and print tasks assigned to the current user from Productive.io.
 * Requires PRODUCTIVE_API_TOKEN, PRODUCTIVE_ORG_ID, and PRODUCTIVE_USER_ID in env or .env.
 */
import { getConfig } from '../config/index.js';
import { ProductiveAPIClient } from '../api/client.js';

async function main(): Promise<void> {
  const config = getConfig();

  if (!config.PRODUCTIVE_USER_ID) {
    console.error('PRODUCTIVE_USER_ID is not set. Set it in .env or environment to see your assigned tasks.');
    process.exit(1);
  }

  const client = new ProductiveAPIClient(config);
  const response = await client.listTasks({
    assignee_id: config.PRODUCTIVE_USER_ID,
    limit: 50,
  });

  if (!response?.data?.length) {
    console.log('You have no tasks assigned to you.');
    return;
  }

  const total = response.meta?.total_count ?? response.data.length;
  console.log(`You have ${response.data.length} task${response.data.length !== 1 ? 's' : ''} assigned to you${total > response.data.length ? ` (showing ${response.data.length} of ${total})` : ''}:\n`);

  for (const task of response.data) {
    if (!task?.attributes) continue;
    const statusIcon = task.attributes.status === 2 ? '✓' : '○';
    const statusText =
      task.attributes.status === 1
        ? 'open'
        : task.attributes.status === 2
          ? 'closed'
          : `status ${task.attributes.status}`;
    const projectId = task.relationships?.project?.data?.id;
    console.log(`${statusIcon} ${task.attributes.title} (ID: ${task.id})`);
    console.log(`  Status: ${statusText}`);
    if (task.attributes.due_date) console.log(`  Due: ${task.attributes.due_date}`);
    if (projectId) console.log(`  Project ID: ${projectId}`);
    if (task.attributes.description) console.log(`  Description: ${task.attributes.description}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
