---
name: verify
summary: Verify runnerize through its CLI and native sandbox lifecycle.
---

# Verify runnerize

- Run `node bin/runnerize.js status` to observe detected flavors through the public CLI. This uses live GitHub authentication and may take several minutes across many repositories.
- For Windows Sandbox lifecycle, start a minimal config with `wsb start --id <guid> --config '<Configuration></Configuration>' --raw`, inspect with `wsb list --raw`, probe a second concurrent start, then always stop the first with `wsb stop --id <guid> --raw`.
- A second concurrent Windows Sandbox must fail with `CO_E_APPSINGLEUSE`; after stop, `wsb list --raw` must be empty.
