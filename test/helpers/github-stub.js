// A hermetic in-memory GitHub REST stub that installs itself as `globalThis.fetch`.
//
// It models exactly the endpoints `src/github.js` calls, records every request for
// assertions, honors ETag / If-None-Match (so the 304 path and the bounded cache can
// be exercised), and exposes hooks so a dispatcher harness can steer a poll cycle.
//
// The real modules are imported unchanged; only `fetch` is swapped, so the tests drive
// the production HTTP client, pagination, backoff, and cache code for real.

const DEFAULT_USER = { login: 'octocat', type: 'User' };

function jsonBody(data) {
  return data === undefined ? '' : JSON.stringify(data);
}

/** Build a real Response with GitHub-shaped headers. */
export function githubResponse(data, { status = 200, etag, headers = {} } = {}) {
  const h = new Headers(headers);
  if (!h.has('content-type')) h.set('content-type', 'application/json; charset=utf-8');
  if (etag) h.set('etag', etag);
  const noBody = status === 204 || status === 304;
  return new Response(noBody ? null : jsonBody(data), { status, headers: h });
}

export class GitHubStub {
  #installed = false;
  #originalFetch;
  #jitSeq = 0;
  #etags = new Map(); // etagKey -> current etag string (for conditional-request modeling)

  constructor(config = {}) {
    this.user = config.user ?? { ...DEFAULT_USER };
    // Repos surfaced by GET /user/repos. Owner defaults to the stub user.
    this.repos = (config.repos ?? []).map((repo) => ({
      private: true,
      fork: false,
      archived: false,
      owner: { login: this.user.login, type: this.user.type },
      ...repo,
    }));
    // Per full_name: array of { id, status } workflow runs.
    this.runs = new Map(Object.entries(config.runs ?? {}));
    // Per run id: array of { status, labels } jobs.
    this.jobs = new Map(Object.entries(config.jobs ?? {}).map(([k, v]) => [String(k), v]));
    // Per full_name: array of registered runners.
    this.runners = new Map(Object.entries(config.runners ?? {}));
    // full_name -> boolean privacy for the isStillPrivate re-check (defaults true).
    this.privateOverrides = new Map(Object.entries(config.privateOverrides ?? {}));
    // Optional per-endpoint fault injection: { key: () => Response|throw }.
    this.faults = config.faults ?? {};
    // Called for every request before the response is built: (method, pathname, ctx).
    this.onRequest = config.onRequest ?? (() => {});
    // Whether conditional GETs should answer 304 when the client's ETag still matches.
    this.enable304 = config.enable304 ?? true;
    // Custom jitconfig generator, else an auto-incrementing one.
    this.jitConfig = config.jitConfig;

    this.calls = [];
    this.fetch = this.fetch.bind(this);
  }

  install() {
    if (this.#installed) return this;
    this.#originalFetch = globalThis.fetch;
    globalThis.fetch = this.fetch;
    this.#installed = true;
    return this;
  }

  restore() {
    if (!this.#installed) return;
    globalThis.fetch = this.#originalFetch;
    this.#installed = false;
  }

  // ---- assertion helpers -------------------------------------------------

  countCalls(method, pathMatcher) {
    return this.calls.filter((c) => c.method === method && this.#matches(c.pathname, pathMatcher)).length;
  }

  callsMatching(method, pathMatcher) {
    return this.calls.filter((c) => c.method === method && this.#matches(c.pathname, pathMatcher));
  }

  #matches(pathname, matcher) {
    if (matcher === undefined) return true;
    if (matcher instanceof RegExp) return matcher.test(pathname);
    return pathname.includes(matcher);
  }

  // ---- the fetch implementation ------------------------------------------

  async fetch(input, init = {}) {
    const url = input instanceof URL ? input : new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const pathname = url.pathname;
    const search = url.searchParams;
    const headers = new Headers(init.headers ?? {});
    const ifNoneMatch = headers.get('if-none-match');
    this.calls.push({ method, pathname, search, ifNoneMatch, body: init.body });

    const ctx = { url, search, headers, init, stub: this };
    const hooked = await this.onRequest(method, pathname, ctx);
    if (hooked instanceof Response) return hooked;

    return this.#route(method, pathname, search, ifNoneMatch);
  }

  #fault(key) {
    const fault = this.faults[key];
    if (!fault) return undefined;
    return fault(this);
  }

  // Serve a GET with ETag support keyed by `etagKey`, mirroring the client's cache logic.
  #cachedGet(etagKey, ifNoneMatch, data) {
    const currentEtag = this.#etags.get(etagKey) ?? `"${etagKey}@0"`;
    if (this.enable304 && ifNoneMatch && ifNoneMatch === currentEtag) {
      return githubResponse(undefined, { status: 304, etag: currentEtag });
    }
    return githubResponse(data, { status: 200, etag: currentEtag });
  }

  /** Bump the ETag for a key so the next conditional GET is a 200, not a 304. */
  bumpEtag(etagKey) {
    const current = this.#etags.get(etagKey) ?? `"${etagKey}@0"`;
    const n = Number(current.match(/@(\d+)"$/)?.[1] ?? 0) + 1;
    this.#etags.set(etagKey, `"${etagKey}@${n}"`);
  }

  // Slice `items` for the 1-based `page` query param, 100 per page (GitHub's max).
  #page(items, search) {
    const page = Number(search.get('page') ?? '1');
    const perPage = Number(search.get('per_page') ?? '100');
    const start = (page - 1) * perPage;
    return items.slice(start, start + perPage);
  }

  #route(method, pathname, search, ifNoneMatch) {
    // GET /user
    if (method === 'GET' && pathname === '/user') {
      return this.#fault('user') ?? this.#cachedGet('user', ifNoneMatch, this.user);
    }

    // GET /user/repos
    if (method === 'GET' && pathname === '/user/repos') {
      const fault = this.#fault('repos');
      if (fault) return fault;
      const page = Number(search.get('page') ?? '1');
      return this.#cachedGet(`owned-repos:${page}`, ifNoneMatch, this.#page(this.repos, search));
    }

    const runnerMatch = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runners\/(\d+)$/);
    if (runnerMatch) {
      const [, full, id] = runnerMatch;
      if (method === 'DELETE') {
        const fault = this.#fault('deleteRunner');
        if (fault) return fault;
        const list = this.runners.get(decodeURIComponent(full)) ?? [];
        const idx = list.findIndex((r) => String(r.id) === id);
        if (idx === -1) return githubResponse(undefined, { status: 404 });
        list.splice(idx, 1);
        return githubResponse(undefined, { status: 204 });
      }
    }

    const jitMatch = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runners\/generate-jitconfig$/);
    if (jitMatch && method === 'POST') {
      const full = decodeURIComponent(jitMatch[1]);
      const fault = this.#fault('jit');
      if (fault) return fault;
      const generated = this.jitConfig
        ? this.jitConfig(full, this)
        : (() => {
            this.#jitSeq += 1;
            return {
              encoded_jit_config: `jit-${this.#jitSeq}`,
              runner: { id: 1000 + this.#jitSeq, name: `runnerize-gen-${this.#jitSeq}` },
            };
          })();
      return githubResponse(generated, { status: 201 });
    }

    const runnersList = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runners$/);
    if (runnersList && method === 'GET') {
      const full = decodeURIComponent(runnersList[1]);
      const fault = this.#fault('listRunners');
      if (fault) return fault;
      const page = Number(search.get('page') ?? '1');
      const items = this.#page(this.runners.get(full) ?? [], search);
      return this.#cachedGet(`runners:${full}:${page}`, ifNoneMatch, { runners: items });
    }

    const jobsMatch = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/jobs$/);
    if (jobsMatch && method === 'GET') {
      const full = decodeURIComponent(jobsMatch[1]);
      const runId = jobsMatch[2];
      const fault = this.#fault('jobs');
      if (fault) return fault;
      const page = Number(search.get('page') ?? '1');
      const items = this.#page(this.jobs.get(String(runId)) ?? [], search);
      return this.#cachedGet(`jobs:${full}:${runId}:${page}`, ifNoneMatch, { jobs: items });
    }

    const runsMatch = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/);
    if (runsMatch && method === 'GET') {
      const full = decodeURIComponent(runsMatch[1]);
      const status = search.get('status');
      const fault = this.#fault('runs');
      if (fault) return fault;
      const page = Number(search.get('page') ?? '1');
      const all = (this.runs.get(full) ?? []).filter((r) => r.status === status);
      return this.#cachedGet(`runs:${full}:${status}:${page}`, ifNoneMatch, {
        workflow_runs: this.#page(all, search),
      });
    }

    // GET /repos/{owner}/{repo} (isStillPrivate re-check)
    const repoMatch = pathname.match(/^\/repos\/([^/]+\/[^/]+)$/);
    if (repoMatch && method === 'GET') {
      const full = decodeURIComponent(repoMatch[1]);
      const fault = this.#fault('repo');
      if (fault) return fault;
      const stillPrivate = this.privateOverrides.has(full) ? this.privateOverrides.get(full) : true;
      return githubResponse({
        full_name: full,
        private: stillPrivate,
        owner: { login: this.user.login, type: this.user.type },
      });
    }

    return githubResponse({ message: `unhandled ${method} ${pathname}` }, { status: 404 });
  }
}

/** Convenience: install a stub, run `fn`, always restore. */
export async function withGitHub(config, fn) {
  const stub = new GitHubStub(config).install();
  try {
    return await fn(stub);
  } finally {
    stub.restore();
  }
}
