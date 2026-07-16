import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { e2eRunId, queueSelfHostedJob, waitForRun, cleanupE2E } from '../helpers/e2e-github.js';

// ---------------------------------------------------------------------------
// REAL end-to-end test.
//
// Requires, via environment:
//   E2E_GH_TOKEN  - a token (repo + workflow scopes) for a throwaway PRIVATE repo
//   E2E_REPO      - "owner/name" of that throwaway private repo
//   podman        - a working rootless container runtime on PATH (native or WSL)
// Optional:
//   RUNNERIZE_LINUX_IMAGE - override the fat image (a smaller image speeds CI)
//   RUNNERIZE_RUNNER_DIR   - use a preinstalled runner dir instead of downloading
//   E2E_TIMEOUT_MS         - overall budget (default 900000 = 15 min)
//
// When the token/repo/runtime are absent the whole suite SKIPS (green locally with no
// infra). It never mutates anything but the throwaway repo, and an `after` hook tears
// down every branch, run, and runner it created so re-runs stay idempotent.
// ---------------------------------------------------------------------------

const TOKEN = process.env.E2E_GH_TOKEN;
const REPO = process.env.E2E_REPO;
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 900_000);
const LABELS = ['self-hosted', 'linux', 'x64'];

// Set GH_TOKEN so the production modules resolve the E2E token, then import them fresh.
if (TOKEN) process.env.GH_TOKEN = TOKEN;

function runtimeProbe() {
  // Mirror how the tool finds a runtime: native podman/docker, or podman/docker in WSL.
  const candidates = process.platform === 'win32'
    ? [['wsl.exe', ['-e', 'podman', '--version']], ['wsl.exe', ['-e', 'docker', '--version']]]
    : [['podman', ['--version']], ['docker', ['--version']]];
  return candidates.reduce((chain, [cmd, args]) => chain.catch(() => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(true) : reject(new Error(`${cmd} exit ${code}`))));
  })), Promise.reject(new Error('start')));
}

let infraReady = false;
let api;
let github;
let container;
let created = { branch: undefined, runnerIds: [] };

before(async () => {
  if (!TOKEN || !REPO) return;
  try {
    await runtimeProbe();
  } catch {
    return;
  }
  // Import the production modules only once the token is in the environment.
  github = await import('../../src/github.js');
  api = github.api;
  container = await import('../../src/sandbox/container.js');
  infraReady = true;
});

after(async () => {
  if (!infraReady || !api) return;
  // Delete any runnerize-* runners still registered (there should be none), then the
  // branch and its runs. Best-effort: log problems but never throw from teardown.
  try {
    const runners = await github.listRunners(REPO);
    for (const runner of runners) {
      if (runner.name?.startsWith('runnerize-')) {
        await github.deleteRunner(REPO, runner.id).catch(() => {});
      }
    }
  } catch { /* ignore */ }
  if (created.branch) {
    const problems = await cleanupE2E(api, REPO, { branch: created.branch });
    if (problems.length) console.error('e2e cleanup problems:', problems);
  }
});

test('JIT runner claims a queued private-repo job, runs it to success, and auto-deregisters', async (t) => {
  if (!TOKEN || !REPO) {
    t.skip('set E2E_GH_TOKEN and E2E_REPO (a throwaway private repo) to run the real E2E');
    return;
  }
  if (!infraReady) {
    t.skip('no container runtime (podman/docker) available for the real E2E');
    return;
  }
  t.diagnostic(`E2E against ${REPO} (timeout ${TIMEOUT_MS}ms)`);

  // 0) Sanity: the repo is private and owned by the token's user (the tool's invariant).
  assert.equal(await github.isStillPrivate(REPO), true, 'E2E_REPO must be a private repo owned by the token user');

  // Baseline: no leaked runnerize-* runners before we start.
  const before = await github.listRunners(REPO);
  const staleBefore = before.filter((r) => r.name?.startsWith('runnerize-'));
  for (const r of staleBefore) await github.deleteRunner(REPO, r.id).catch(() => {});

  // 1) Queue exactly one self-hosted job by pushing a workflow to a fresh branch.
  //    Flat branch name (no slash) so the workflow file lands directly under
  //    .github/workflows/ where GitHub will scan it.
  const runId = e2eRunId();
  const branch = `runnerize-e2e-${runId}`;
  const marker = `runnerize-e2e-${runId}`;
  created.branch = branch;
  await queueSelfHostedJob(api, REPO, { branch, jobEcho: marker });

  // 2) Wait for GitHub to surface the queued run, and confirm the tool counts the demand.
  const queuedRun = await waitForRun(
    api, REPO, branch,
    (run) => run.status === 'queued' || run.status === 'in_progress',
    { timeoutMs: 120_000 },
  );
  assert.ok(queuedRun, 'the pushed workflow produced a run');

  // The tool's demand count should see the queued self-hosted job. Job labels can lag a
  // beat behind the run appearing, so poll briefly before asserting.
  let demand = 0;
  for (let i = 0; i < 15; i += 1) {
    demand = await github.countQueuedMatchingJobs(REPO, LABELS, { isDefault: true });
    if (demand >= 1) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  assert.ok(demand >= 1, `the tool counts the queued self-hosted job as demand (saw ${demand})`);

  // 3) Drive the real mint + launch path: generate a JIT config and launch one runner in
  //    a throwaway rootless container. This is the exact sequence the dispatcher runs.
  const jit = await github.generateJitConfig(REPO, LABELS);
  assert.match(jit.encodedJitConfig, /.+/, 'received an encoded JIT config');
  assert.ok(jit.runnerId, 'received a runner id');
  created.runnerIds.push(jit.runnerId);

  const launchResult = await container.linux.launch(jit.encodedJitConfig, {
    idleTimeoutMs: Math.min(TIMEOUT_MS, 600_000),
  });
  assert.deepEqual(launchResult, { startedJob: true }, 'the JIT runner picked up and ran the job');

  // 4) The run must reach a successful conclusion.
  const completed = await waitForRun(
    api, REPO, branch,
    (run) => run.status === 'completed',
    { timeoutMs: TIMEOUT_MS },
  );
  assert.ok(completed, 'the workflow run completed');
  assert.equal(completed.conclusion, 'success', 'the job concluded successfully');

  // 5) The ephemeral runner auto-deregistered: 0 leaked runnerize-* registrations.
  //    Auto-deregistration lags a beat behind job completion and, under CI load, can take
  //    well over a minute — poll generously so a slow-but-eventual deregistration is not a flake.
  let leaked = [];
  for (let i = 0; i < 40; i += 1) {
    const runners = await github.listRunners(REPO);
    leaked = runners.filter((r) => r.name?.startsWith('runnerize-'));
    if (leaked.length === 0) break;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  assert.deepEqual(leaked.map((r) => r.name), [], 'the JIT runner auto-deregistered; nothing leaked');
});
