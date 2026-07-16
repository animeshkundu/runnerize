import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const API_ROOT = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const etagCache = new Map();
const ETAG_CACHE_MAX = 500;
let cachedToken;
let rateLimitPausedUntil = 0;
let rateLimitGate;

function abortError(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).then(cleanup, cleanup);
  });
}

function pauseRateLimit(ms) {
  const pausedUntil = Date.now() + Math.min(Math.max(0, ms), 60_000);
  if (pausedUntil <= rateLimitPausedUntil) return;

  rateLimitPausedUntil = pausedUntil;
  rateLimitGate = new Promise((resolve) => setTimeout(resolve, pausedUntil - Date.now()));
}

async function awaitRateLimit(signal) {
  while (rateLimitGate && Date.now() < rateLimitPausedUntil) {
    await waitFor(rateLimitGate, signal);
  }
}

function repoPath(fullName) {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

function parseResponseData(text, contentType) {
  if (!text) return null;
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function retryDelayMs(response, attempt) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1_000));

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
  }

  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(60_000, Math.max(0, reset * 1_000 - Date.now()));
  }

  return Math.min(60_000, 1_000 * 2 ** attempt);
}

function rateLimitDelayMs(response, data, attempt) {
  const remainingHeader = response.headers.get('x-ratelimit-remaining');
  const remaining = Number(remainingHeader);
  if (response.headers.has('retry-after')
    || (remainingHeader !== null && Number.isFinite(remaining) && remaining <= 1)
    || isRateLimited(response, data)) {
    return retryDelayMs(response, attempt);
  }
  return 0;
}

function isRateLimited(response, data) {
  if (response.status !== 403) return false;
  if (response.headers.has('retry-after')) return true;
  if (response.headers.get('x-ratelimit-remaining') === '0') return true;

  const message = typeof data?.message === 'string' ? data.message.toLowerCase() : '';
  return message.includes('secondary rate limit') || message.includes('abuse detection');
}

function assertSuccess(result, operation) {
  if (!result.notModified && (result.status < 200 || result.status >= 300)) {
    const error = new Error(`${operation} failed with GitHub API status ${result.status}`);
    error.status = result.status;
    error.data = result.data;
    throw error;
  }
  return result.data;
}

async function paginated(pathForPage, etagPrefix, selectItems = (data) => data, { signal } = {}) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const result = await api('GET', pathForPage(page), {
      etagKey: etagPrefix ? `${etagPrefix}:${page}` : undefined,
      signal,
    });
    const data = assertSuccess(result, `GET ${pathForPage(page)}`);
    const pageItems = selectItems(data);
    if (!Array.isArray(pageItems)) throw new Error('GitHub API returned an invalid paginated response');
    items.push(...pageItems);
    if (pageItems.length < 100) return items;
  }
}

export async function getToken({ signal } = {}) {
  if (cachedToken) return cachedToken;
  if (signal?.aborted) throw abortError(signal);

  const envToken = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (envToken) {
    cachedToken = envToken;
    return cachedToken;
  }

  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      timeout: DEFAULT_TIMEOUT_MS,
      windowsHide: true,
      signal,
    });
    const token = stdout.trim();
    if (!token) throw new Error('No GitHub token is available');
    cachedToken = token;
    return cachedToken;
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    const tokenPath = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'runnerize', 'windows.token');
    if (!existsSync(tokenPath)) throw error;
    try {
      const script = `$ErrorActionPreference = 'Stop'; [Console]::Out.Write([System.Net.NetworkCredential]::new('', (Get-Content -LiteralPath '${tokenPath.replaceAll("'", "''")}' | ConvertTo-SecureString)).Password)`;
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', script,
      ], { encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS, windowsHide: true, signal });
      const token = stdout.trim();
      if (!token) throw new Error('decrypted token was empty');
      cachedToken = token;
      return cachedToken;
    } catch (decryptError) {
      throw new Error(`Could not decrypt the persisted Windows credential at ${tokenPath}`, { cause: decryptError });
    }
  }
}

export async function api(method, path, {
  body,
  etagKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
} = {}) {
  const token = await getToken({ signal });
  const cached = etagKey ? etagCache.get(etagKey) : undefined;

  for (let attempt = 0; ; attempt += 1) {
    await awaitRateLimit(signal);

    const controller = new AbortController();
    const onAbort = () => controller.abort(abortError(signal));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cached?.etag) headers['If-None-Match'] = cached.etag;

    let response;
    let text;
    try {
      response = await fetch(new URL(path, API_ROOT), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      text = response.status === 304 ? '' : await response.text();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (response.status === 304) {
      return { status: 304, data: cached?.data, notModified: true };
    }

    const data = parseResponseData(text, response.headers.get('content-type') || '');
    const delay = rateLimitDelayMs(response, data, attempt);
    if (delay > 0) pauseRateLimit(delay);
    if (isRateLimited(response, data) && attempt < MAX_RATE_LIMIT_RETRIES) {
      await awaitRateLimit(signal);
      continue;
    }

    if (etagKey && response.ok) {
      const etag = response.headers.get('etag');
      if (etag) {
        // Bounded LRU: re-insert to mark most-recently-used, evict oldest past the cap.
        // Ephemeral per-run job keys (jobs:repo:run.id) would otherwise leak unboundedly.
        etagCache.delete(etagKey);
        etagCache.set(etagKey, { etag, data });
        if (etagCache.size > ETAG_CACHE_MAX) etagCache.delete(etagCache.keys().next().value);
      }
    }
    return { status: response.status, data, notModified: false };
  }
}

export async function getUser({ signal } = {}) {
  const data = assertSuccess(await api('GET', '/user', { etagKey: 'user', signal }), 'Get user');
  return { login: data.login, type: data.type };
}

// Repos the operator never wants dispatched to, from RUNNERIZE_EXCLUDE_REPOS
// (comma/whitespace-separated "owner/name", case-insensitive). Use it to keep a
// long-running local dispatcher off repos whose self-hosted jobs are served
// elsewhere — e.g. runnerize's own CI test repo, so the two don't race for a job.
function excludedRepos() {
  const raw = process.env.RUNNERIZE_EXCLUDE_REPOS;
  if (!raw) return new Set();
  return new Set(raw.split(/[\s,]+/).map((name) => name.trim().toLowerCase()).filter(Boolean));
}

export async function listOwnedPrivateRepos({ signal } = {}) {
  const me = await getUser({ signal });
  const excluded = excludedRepos();
  const repos = await paginated(
    (page) => `/user/repos?affiliation=owner&per_page=100&page=${page}`,
    'owned-repos',
    undefined,
    { signal },
  );

  return repos
    .filter((repo) => repo.private === true
      && repo.owner?.login === me.login
      && repo.owner?.type === 'User'
      && repo.fork !== true
      && repo.archived !== true
      && !excluded.has(repo.full_name?.toLowerCase()))
    .map(({ full_name, private: isPrivate, fork, archived }) => ({
      full_name,
      private: isPrivate,
      fork,
      archived,
    }));
}

export async function isStillPrivate(fullName, { signal } = {}) {
  try {
    const me = await getUser({ signal });
    const result = await api('GET', `/repos/${repoPath(fullName)}`, { signal });
    if (result.status < 200 || result.status >= 300) return false;
    return result.data?.private === true
      && result.data.owner?.login === me.login
      && result.data.owner?.type === 'User';
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

export async function countQueuedMatchingJobs(
  fullName,
  flavorLabels,
  { isDefault = false, signal } = {},
) {
  const repo = repoPath(fullName);
  const normalizedFlavorLabels = new Set(flavorLabels.map((label) => label.toLowerCase()));
  const genericLabels = new Set(['self-hosted', 'x64', 'arm64']);
  const osLabel = flavorLabels
    .map((label) => label.toLowerCase())
    .find((label) => !genericLabels.has(label));
  const runsById = new Map();

  for (const status of ['queued', 'in_progress']) {
    const runs = await paginated(
      (page) => `/repos/${repo}/actions/runs?status=${status}&per_page=100&page=${page}`,
      `runs:${fullName}:${status}`,
      (data) => data?.workflow_runs,
      { signal },
    );
    for (const run of runs) runsById.set(run.id, run);
  }

  let count = 0;
  for (const run of runsById.values()) {
    const jobs = await paginated(
      (page) => `/repos/${repo}/actions/runs/${encodeURIComponent(run.id)}/jobs?per_page=100&page=${page}`,
      `jobs:${fullName}:${run.id}`,
      (data) => data?.jobs,
      { signal },
    );
    count += jobs.filter((job) => {
      if (job.status !== 'queued' || !Array.isArray(job.labels)) return false;
      const jobLabels = job.labels.map((label) => label.toLowerCase());
      return jobLabels.every((label) => normalizedFlavorLabels.has(label))
        && (isDefault || (osLabel !== undefined && jobLabels.includes(osLabel)));
    }).length;
  }

  return count;
}

export async function generateJitConfig(fullName, labels, { signal } = {}) {
  const data = assertSuccess(await api(
    'POST',
    `/repos/${repoPath(fullName)}/actions/runners/generate-jitconfig`,
    {
      body: {
        name: `runnerize-${randomBytes(4).toString('hex')}`,
        runner_group_id: 1,
        labels,
        work_folder: '_work',
      },
      signal,
    },
  ), 'Generate JIT runner config');

  if (typeof data?.encoded_jit_config !== 'string'
    || data?.runner?.id === undefined
    || typeof data.runner.name !== 'string') {
    throw new Error('GitHub API did not return a complete JIT runner config');
  }
  return {
    encodedJitConfig: data.encoded_jit_config,
    runnerId: data.runner.id,
    runnerName: data.runner.name,
  };
}

export async function listRunners(fullName, { signal } = {}) {
  const runners = await paginated(
    (page) => `/repos/${repoPath(fullName)}/actions/runners?per_page=100&page=${page}`,
    `runners:${fullName}`,
    (data) => data?.runners,
    { signal },
  );
  return runners.map((runner) => ({
    id: runner.id,
    name: runner.name,
    status: runner.status,
    labels: Array.isArray(runner.labels)
      ? runner.labels.map((label) => typeof label === 'string' ? label : label.name)
      : [],
  }));
}

export async function deleteRunner(fullName, id, { signal } = {}) {
  const result = await api(
    'DELETE',
    `/repos/${repoPath(fullName)}/actions/runners/${encodeURIComponent(id)}`,
    { signal },
  );
  if (result.status === 404) return;
  assertSuccess(result, 'Delete runner');
}
