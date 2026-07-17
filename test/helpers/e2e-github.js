// End-to-end helpers: queue a real workflow job in a throwaway private repo by pushing a
// self-hosted workflow to a fresh branch, then tear everything down. Everything goes
// through the production `api()` client with the E2E token, so the same HTTP path the
// tool uses in anger is exercised here.

import { randomBytes } from 'node:crypto';

const WORKFLOW_DIR = '.github/workflows';

export function e2eRunId() {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** The self-hosted workflow we push. `on: push` to its own branch queues exactly one job. */
export function workflowYaml(branch, jobEcho) {
  return [
    'name: runnerize-e2e',
    'on:',
    '  push:',
    `    branches: ['${branch}']`,
    'jobs:',
    '  smoke:',
    '    runs-on: [self-hosted, linux, x64]',
    '    steps:',
    `      - run: echo "${jobEcho}"`,
    '',
  ].join('\n');
}

/**
 * Create `branch` off the repo's default branch and push a self-hosted workflow file to
 * it. The push event queues a workflow run. `branch` must be a flat name (no slash) so
 * the workflow file lands directly under `.github/workflows/` — GitHub does not scan
 * workflows in subdirectories. Returns { branch, path, headSha }.
 */
export async function queueSelfHostedJob(api, repo, { branch, jobEcho }) {
  if (branch.includes('/')) {
    throw new Error(`e2e branch must be flat (no "/"), got ${branch}; else the workflow path nests into a subdir`);
  }
  const repoInfo = await api('GET', `/repos/${repo}`);
  if (repoInfo.status < 200 || repoInfo.status >= 300) {
    throw new Error(`cannot read repo ${repo}: HTTP ${repoInfo.status}`);
  }
  const defaultBranch = repoInfo.data.default_branch;

  const baseRef = await api('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  const baseSha = baseRef.data?.object?.sha;
  if (!baseSha) throw new Error(`could not resolve the base SHA for ${repo}@${defaultBranch}`);

  const created = await api('POST', `/repos/${repo}/git/refs`, {
    body: { ref: `refs/heads/${branch}`, sha: baseSha },
  });
  if (created.status < 200 || created.status >= 300) {
    throw new Error(`could not create branch ${branch}: HTTP ${created.status}`);
  }

  // Directly under .github/workflows/, filename keyed off the flat branch name.
  const path = `${WORKFLOW_DIR}/${branch}.yml`;
  const put = await api('PUT', `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    body: {
      message: `ci(e2e): queue runnerize self-hosted smoke on ${branch}`,
      content: Buffer.from(workflowYaml(branch, jobEcho), 'utf8').toString('base64'),
      branch,
    },
  });
  if (put.status < 200 || put.status >= 300) {
    throw new Error(`could not push the workflow to ${branch}: HTTP ${put.status}`);
  }
  return { branch, path, headSha: put.data?.commit?.sha };
}

/** Poll until a predicate over the branch's workflow runs is satisfied, or time out. */
export async function waitForRun(api, repo, branch, predicate, { timeoutMs = 120_000, intervalMs = 4_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api('GET', `/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=20`);
    const runs = res.data?.workflow_runs ?? [];
    const hit = runs.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Best-effort teardown: cancel/delete runs and delete the branch. */
export async function cleanupE2E(api, repo, { branch } = {}) {
  const problems = [];

  // Delete workflow runs on the branch (must be completed to delete; cancel first).
  try {
    const res = await api('GET', `/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=50`);
    for (const run of res.data?.workflow_runs ?? []) {
      if (run.status !== 'completed') {
        await api('POST', `/repos/${repo}/actions/runs/${run.id}/cancel`).catch(() => {});
      }
      await api('DELETE', `/repos/${repo}/actions/runs/${run.id}`).catch((e) => problems.push(`run ${run.id}: ${e.message}`));
    }
  } catch (e) {
    problems.push(`list runs: ${e.message}`);
  }

  // Delete the branch (removes the workflow file with it).
  if (branch) {
    try {
      await api('DELETE', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`);
    } catch (e) {
      problems.push(`delete branch: ${e.message}`);
    }
  }

  return problems;
}
