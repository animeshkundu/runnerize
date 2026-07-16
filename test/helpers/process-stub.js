// A controllable `node:child_process` stub for hermetic tests.
//
// ESM named imports (`import { spawn } from 'node:child_process'`) bind to the CJS
// module's live exports, so mutating the CJS export object and calling
// `syncBuiltinESMExports()` makes the swap visible to already-imported production
// modules. This lets `src/sandbox/container.js` and the `gh auth token` path in
// `src/github.js` run for real against scripted fake processes.

import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

/** A fake ChildProcess: EventEmitter with stdout/stderr streams and a kill() spy. */
export class FakeChild extends EventEmitter {
  constructor(command, args, options) {
    super();
    this.command = command;
    this.args = args ?? [];
    this.options = options ?? {};
    this.stdin = new EventEmitter();
    this.stdin.chunks = [];
    this.stdin.end = (chunk) => {
      if (chunk !== undefined) this.stdin.chunks.push(Buffer.from(chunk));
      this.stdin.emit('finish');
    };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.signals = [];
    this.killed = false;
  }

  kill(signal = 'SIGTERM') {
    this.signals.push(signal);
    this.killed = true;
    return true;
  }

  // ---- driver conveniences ----
  emitStdout(text) { this.stdout.emit('data', Buffer.from(text)); return this; }
  emitStderr(text) { this.stderr.emit('data', Buffer.from(text)); return this; }
  close(code = 0) { this.emit('exit', code); this.emit('close', code); return this; }
  fail(error) { this.emit('error', error instanceof Error ? error : new Error(String(error))); return this; }

  /** Convenience: emit a line the runner prints when it picks up a job. */
  startJob() { return this.emitStdout('2026-01-01T00:00:00Z: Running job: build\n'); }
}

/**
 * Installs a scripted `spawn`. `handler(child)` runs on the next microtask after each
 * spawn call, letting the test script the child's lifecycle. All spawned children are
 * recorded on `.children`.
 */
export class SpawnStub {
  #installed = false;
  #originalSpawn;

  constructor(handler = () => {}) {
    this.handler = handler;
    this.children = [];
    this.spawn = this.spawn.bind(this);
  }

  spawn(command, args, options) {
    const child = new FakeChild(command, args, options);
    this.children.push(child);
    queueMicrotask(() => this.handler(child, this));
    return child;
  }

  /** First recorded child whose args include every token in `tokens`. */
  find(...tokens) {
    return this.children.find((c) => tokens.every((t) => (c.args ?? []).includes(t)));
  }

  install() {
    if (this.#installed) return this;
    this.#originalSpawn = childProcess.spawn;
    childProcess.spawn = this.spawn;
    syncBuiltinESMExports();
    this.#installed = true;
    return this;
  }

  restore() {
    if (!this.#installed) return;
    childProcess.spawn = this.#originalSpawn;
    syncBuiltinESMExports();
    this.#installed = false;
  }
}

/**
 * Installs a scripted `execFile` (used by `getToken`'s `gh auth token` and
 * `platform.js`'s `ioreg`/`reg.exe`). `impl(command, args, options)` returns
 * `{ stdout, stderr }` or throws. `promisify(execFile)` is bound at import time in the
 * production module, so we patch the underlying export and re-sync.
 */
export class ExecFileStub {
  #installed = false;
  #original;

  constructor(impl) {
    this.impl = impl;
    this.calls = [];
    this.execFile = this.execFile.bind(this);
    // `src/github.js` calls `promisify(execFile)`. The real execFile carries a
    // `util.promisify.custom` implementation that resolves to `{ stdout, stderr }`;
    // without it, promisify would resolve to the bare first callback arg. Mirror that.
    this.execFile[promisify.custom] = (file, args, options) => {
      let a = args;
      let opts = options;
      if (typeof a === 'object' && !Array.isArray(a) && opts === undefined) { opts = a; a = []; }
      this.calls.push({ file, args: a ?? [], options: opts ?? {} });
      return Promise.resolve()
        .then(() => this.impl(file, a ?? [], opts ?? {}))
        .then((result) => (typeof result === 'string' ? { stdout: result, stderr: '' } : result));
    };
  }

  // Node's execFile signature: (file, args?, options?, callback).
  execFile(file, args, options, callback) {
    let cb = callback;
    let opts = options;
    let a = args;
    if (typeof a === 'function') { cb = a; a = []; opts = {}; }
    else if (typeof opts === 'function') { cb = opts; opts = {}; }
    this.calls.push({ file, args: a ?? [], options: opts ?? {} });

    Promise.resolve()
      .then(() => this.impl(file, a ?? [], opts ?? {}))
      .then(
        (result) => {
          const out = typeof result === 'string' ? { stdout: result, stderr: '' } : result;
          cb?.(null, out.stdout ?? '', out.stderr ?? '');
        },
        (error) => cb?.(error, error?.stdout ?? '', error?.stderr ?? ''),
      );
    // execFile returns a ChildProcess; production code that promisifies ignores it.
    return new FakeChild(file, a ?? [], opts ?? {});
  }

  install() {
    if (this.#installed) return this;
    this.#original = childProcess.execFile;
    childProcess.execFile = this.execFile;
    syncBuiltinESMExports();
    this.#installed = true;
    return this;
  }

  restore() {
    if (!this.#installed) return;
    childProcess.execFile = this.#original;
    syncBuiltinESMExports();
    this.#installed = false;
  }
}
