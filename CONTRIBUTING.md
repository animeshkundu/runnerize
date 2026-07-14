# Contributing to runnerize

Thanks for helping out. runnerize is a small, zero-dependency CLI with a few
non-negotiable invariants; contributions that respect those are easy to merge.

If you're an AI agent, read [`AGENTS.md`](AGENTS.md) first — it has the invariants,
the module map, and the "leave it better" checklist. This document is the human
quick-start.

## Setup

You need:

- **Node.js ≥ 18** (runnerize uses the built-in `fetch`; there are no npm deps to
  install, so `npm install` does effectively nothing but is harmless).
- For anything touching the `linux` sandbox: a container runtime — **`podman`**
  (preferred) or **`docker`** — native on Linux, or inside a **WSL2** distro on
  Windows. macOS needs a Linux VM (`colima` / `podman machine`).
- A **GitHub token** for the read/e2e paths: `$GH_TOKEN` / `$GITHUB_TOKEN`, or a
  logged-in `gh` CLI (`gh auth token`).

Clone and sanity-check:

```bash
git clone https://github.com/animeshkundu/runnerize
cd runnerize
node bin/runnerize.js --help
npm test
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for cross-platform dev (Windows+WSL,
native Linux, macOS), the `RUNNERIZE_*` env knobs, and the throwaway spike-repo
pattern for exercising a real end-to-end dispatch.

## Tests are a required gate

- `npm test` — unit tests (`node --test test/unit`). **Must pass** before a PR.
- `npm run test:e2e` — end-to-end (`node --test test/e2e`); needs a runtime + token.
- `npm run test:all` — both.

Rules of the road:

- **Every change ships with tests.** A bug fix includes a regression test that would
  have failed before the fix. A new behavior includes tests for it.
- **Don't claim green you didn't see.** If you couldn't run the e2e path (no runtime
  or token), say so in the PR instead of implying it passed.
- A failing or flaky test you notice is worth fixing while you're there, whoever
  introduced it.

## The invariants (do not regress)

These are enforced by review and are spelled out in full in [`AGENTS.md`](AGENTS.md).
In short: **count-based, never job-pinned**; **fail-closed privacy re-check before
every mint**; **tokens off argv and never logged**; **semaphore released exactly
once**; **stateless/ephemeral one-job runners**; **idle watchdog kills unclaimed
runners**; **zero dependencies**. If your change would weaken one of these, it's the
wrong change.

Anything touching auth, the container/sandbox path, or credential handling gets extra
scrutiny — flag it clearly in the PR.

## Pull request flow

1. Branch off `main`.
2. Make the change. Keep it focused; unrelated cleanups can ride along but say so.
3. Update docs in the same PR when behavior, contracts, or invariants change
   (`AGENTS.md`, `CONTRACTS.md`, `docs/`, and note any `README.md` impact).
4. Run `npm test` (and `npm run test:e2e` if you can).
5. Open the PR; fill in the template, including the **invariant checklist** and **how
   you verified**.
6. All PRs need review from the code owner (see `.github/CODEOWNERS`).

## Commit & PR style

- **Imperative subject line**, present tense: "Add idle-watchdog force-settle",
  "Fix WSL runner staging race". Keep it under ~72 chars; add a body if the *why*
  isn't obvious.
- One logical change per commit where practical.
- **No attribution to any AI, assistant, or tool** — no `Co-Authored-By` for
  assistants, no "generated with" markers, in commits or PRs. This is a hard rule;
  scan your commits before pushing.

## Code conventions

- Modern ESM, 2-space indent, LF line endings (`.editorconfig` / `.gitattributes`
  enforce LF — a CRLF sneaking into an embedded bash script breaks the runner).
- Small, defensive functions: timeouts on anything that can hang, `try/finally` for
  cleanup, validate inputs.
- Structured logging only — one JSON line via the `log()` helper, never a secret in
  a field.
- No new runtime dependencies. Reach for a Node built-in first.

## Reporting bugs / requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For bugs, include your host,
container runtime, the workflow's `runs-on:` labels, and the relevant JSON log lines
(**scrub any token first**). For features, note how the idea stays within the
invariants.

## License

By contributing you agree your contributions are licensed under the project's
[MIT License](LICENSE).
