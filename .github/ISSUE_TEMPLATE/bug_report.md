---
name: Bug report
about: Something in runnerize misbehaves
title: ""
labels: bug
assignees: ""
---

## What happened

<!-- A clear, specific description of the bug. -->

## Expected

<!-- What you expected instead. -->

## Reproduction

<!--
The dispatcher's behavior depends on your host and your GitHub account state.
The more of this you can give, the faster it gets fixed.
-->

1. Command run: <!-- e.g. `node bin/runnerize.js run --dry-run` -->
2. Host: <!-- Linux / Windows+WSL / macOS -->
3. Container runtime: <!-- podman / docker, native or inside which WSL distro -->
4. What the queued workflow's `runs-on:` labels were:

## Logs

<!--
runnerize logs one JSON object per line. Paste the relevant lines.
IMPORTANT: never paste a token. Scrub anything that looks like a credential.
-->

```
<paste JSON log lines here>
```

## Environment

- `node --version`:
- runnerize version / commit:
- OS + version:
- `RUNNERIZE_*` env vars set (names only, not secret values):

## Anything else

<!-- Screenshots, related issues, guesses at root cause. -->
