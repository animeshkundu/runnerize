import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const API_ROOT = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const etagCache = new Map();
let cachedToken;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }

  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1_000 - Date.now());
  }

  return 1_000 * 2 ** attempt;
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

async function paginated(pathForPage, etagPrefix, selectItems = (data) => data) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const result = await api('GET', pathForPage(page), {
      etagKey: etagPrefix ? `${etagPrefix}:${page}` : undefined,
    });
    const data = assertSuccess(result, `GET ${pathForPage(page)}`);
    const pageItems = selectItems(data);
    if (!Array.isArray(pageItems)) throw new Error('GitHub API returned an invalid paginated response');
    items.push(...pageItems);
    if (pageItems.length < 100) return items;
  }
}

export async function getToken() {
  if (cachedToken) return cachedToken;

  const envToken = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (envToken) {
    cachedToken = envToken;
    return cachedToken;
  }

  const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    timeout: DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  });
  const token = stdout.trim();
  if (!token) throw new Error('No GitHub token is available');
  cachedToken = token;
  return cachedToken;
}

export async function api(method, path, { body, etagKey, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const token = await getToken();
  const cached = etagKey ? etagCache.get(etagKey) : undefined;

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cached?.etag) headers['If-None-Match'] = cached.etag;

    let response;
    try {
      response = await fetch(new URL(path, API_ROOT), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 304) {
      return { status: 304, data: cached?.data, notModified: true };
    }

    const text = await response.text();
    const data = parseResponseData(text, response.headers.get('content-type') || '');
    if (isRateLimited(response, data) && attempt < MAX_RATE_LIMIT_RETRIES) {
      await sleep(retryDelayMs(response, attempt));
      continue;
    }

    if (etagKey && response.ok) {
      const etag = response.headers.get('etag');
      if (etag) etagCache.set(etagKey, { etag, data });
    }
    return { status: response.status, data, notModified: false };
  }
}

export async function getUser() {
  const data = assertSuccess(await api('GET', '/user', { etagKey: 'user' }), 'Get user');
  return { login: data.login, type: data.type };
}

export async function listOwnedPrivateRepos() {
  const me = await getUser();
  const repos = await paginated(
    (page) => `/user/repos?affiliation=owner&per_page=100&page=${page}`,
    'owned-repos',
  );

  return repos
    .filter((repo) => repo.private === true
      && repo.owner?.login === me.login
      && repo.owner?.type === 'User'
      && repo.fork !== true
      && repo.archived !== true)
    .map(({ full_name, private: isPrivate, fork, archived }) => ({
      full_name,
      private: isPrivate,
      fork,
      archived,
    }));
}

export async function isStillPrivate(fullName) {
  try {
    const me = await getUser();
    const result = await api('GET', `/repos/${repoPath(fullName)}`);
    if (result.status < 200 || result.status >= 300) return false;
    return result.data?.private === true
      && result.data.owner?.login === me.login
      && result.data.owner?.type === 'User';
  } catch {
    return false;
  }
}

export async function countQueuedMatchingJobs(fullName, flavorLabels) {
  const repo = repoPath(fullName);
  const normalizedFlavorLabels = new Set(flavorLabels.map((label) => label.toLowerCase()));
  let count = 0;

  for (const status of ['queued', 'in_progress']) {
    const runs = await paginated(
      (page) => `/repos/${repo}/actions/runs?status=${status}&per_page=100&page=${page}`,
      `runs:${fullName}:${status}`,
      (data) => data?.workflow_runs,
    );

    for (const run of runs) {
      const jobs = await paginated(
        (page) => `/repos/${repo}/actions/runs/${encodeURIComponent(run.id)}/jobs?per_page=100&page=${page}`,
        `jobs:${fullName}:${run.id}`,
        (data) => data?.jobs,
      );
      count += jobs.filter((job) => job.status === 'queued'
        && Array.isArray(job.labels)
        && job.labels.every((label) => normalizedFlavorLabels.has(label.toLowerCase()))).length;
    }
  }

  return count;
}

export async function generateJitConfig(fullName, labels) {
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
    },
  ), 'Generate JIT runner config');

  if (typeof data?.encoded_jit_config !== 'string') {
    throw new Error('GitHub API did not return an encoded JIT runner config');
  }
  return data.encoded_jit_config;
}

export async function listRunners(fullName) {
  const runners = await paginated(
    (page) => `/repos/${repoPath(fullName)}/actions/runners?per_page=100&page=${page}`,
    `runners:${fullName}`,
    (data) => data?.runners,
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

export async function deleteRunner(fullName, id) {
  const result = await api(
    'DELETE',
    `/repos/${repoPath(fullName)}/actions/runners/${encodeURIComponent(id)}`,
  );
  if (result.status === 404) return;
  assertSuccess(result, 'Delete runner');
}
