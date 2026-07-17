#!/usr/bin/env node

import {
  countQueuedMatchingJobs,
  deleteRunner,
  getUser,
  listOwnedPrivateRepos,
  listRunners,
} from '../src/github.js';
import { runDispatcher } from '../src/dispatcher.js';
import { detectFlavors, FLAVOR_KEYS } from '../src/sandbox/index.js';
import { installService, preflightRun, uninstallService } from '../src/service.js';
import { guardStatus, installGuard, uninstallGuard } from '../src/guard.js';

const HELP = `runnerize - on-demand ephemeral GitHub Actions runners

Usage:
  runnerize run [--max <n>] [--interval <ms>] [--idle-timeout <ms>] [--only <csv>] [--no-keep-awake] [--dry-run]
  runnerize status
  runnerize remove
  runnerize service install|uninstall [--no-elevate]
  runnerize guard install [--shutdown-guard] | uninstall | status
  runnerize --help

Options:
  --max <n>              Maximum concurrent runners (default: 4)
  --interval <ms>        Poll interval in milliseconds (default: 15000)
  --idle-timeout <ms>    Kill an unclaimed runner after this time (default: 120000)
  --only <csv>           Serve only these flavors: linux, windows, macos
  --no-keep-awake        Allow the host to sleep while the dispatcher runs
  --dry-run              Count and display demand without minting runners
  --no-elevate           Never prompt for administrator access during service setup
  --shutdown-guard       Reserved for the Tier-2 shutdown guard (not yet implemented)
  -h, --help             Show this help
`;

function positiveInteger(raw, flag) {
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return Number(raw);
}

function parseRunFlags(args) {
  const options = { keepAwake: true };
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case '--max':
        options.maxConcurrent = positiveInteger(args[++index], flag);
        break;
      case '--interval':
        options.pollIntervalMs = positiveInteger(args[++index], flag);
        break;
      case '--idle-timeout':
        options.idleTimeoutMs = positiveInteger(args[++index], flag);
        break;
      case '--only': {
        const raw = args[++index];
        if (!raw) throw new Error('--only requires a non-empty comma-separated flavor list');
        const keys = raw.split(',').map((key) => key.trim()).filter(Boolean);
        if (keys.length === 0) throw new Error('--only requires a non-empty comma-separated flavor list');
        const invalid = keys.filter((key) => !FLAVOR_KEYS.has(key));
        if (invalid.length) throw new Error(`Unknown flavor(s) for --only: ${invalid.join(', ')}`);
        options.only = new Set(keys);
        break;
      }
      case '--no-keep-awake':
        options.keepAwake = false;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return { options, dryRun };
}

async function collectState({ includeDemand = false, only } = {}) {
  const [user, repos, flavors] = await Promise.all([
    getUser(),
    listOwnedPrivateRepos(),
    detectFlavors(only),
  ]);

  const repositoryState = [];
  for (const repo of repos) {
    const runners = await listRunners(repo.full_name);
    const demand = {};
    if (includeDemand) {
      for (const flavor of flavors) {
        demand[flavor.key] = await countQueuedMatchingJobs(repo.full_name, flavor.labels);
      }
    }
    repositoryState.push({ name: repo.full_name, runners, demand });
  }

  return { user, repos, flavors, repositoryState };
}

async function dryRun(only) {
  const state = await collectState({ includeDemand: true, only });
  if (only && state.flavors.length === 0) {
    console.warn(`No requested flavors are available: ${[...only].join(', ')}`);
  }
  console.log(`Authenticated as ${state.user.login} (${state.user.type})`);
  console.log(`Owned private repositories: ${state.repos.length}`);
  console.log(`Available flavors: ${state.flavors.map((flavor) => flavor.key).join(', ') || 'none'}`);
  for (const repo of state.repositoryState) {
    const counts = Object.entries(repo.demand)
      .map(([flavor, count]) => `${flavor}=${count}`)
      .join(' ');
    console.log(`${repo.name}: ${counts || 'no available flavors'}`);
  }
  console.log('Dry run complete. No runners were minted.');
}

async function status() {
  const state = await collectState();
  console.log(`Authenticated as ${state.user.login} (${state.user.type})`);
  console.log(`Owned private repositories: ${state.repos.length}`);
  for (const flavor of state.flavors) {
    console.log(`Flavor ${flavor.key}: labels=[${flavor.labels.join(', ')}]`);
  }

  let count = 0;
  for (const repo of state.repositoryState) {
    for (const runner of repo.runners) {
      count += 1;
      const labels = runner.labels.map((label) =>
        typeof label === 'string' ? label : label.name,
      );
      console.log(`${repo.name}: ${runner.name} id=${runner.id} status=${runner.status} labels=[${labels.join(', ')}]`);
    }
  }
  if (count === 0) console.log('Currently registered runners: none');
}

async function remove() {
  const repos = await listOwnedPrivateRepos();
  let removed = 0;

  for (const repo of repos) {
    const runners = await listRunners(repo.full_name);
    for (const runner of runners) {
      if (runner.status === 'offline' && runner.name.startsWith('runnerize-')) {
        await deleteRunner(repo.full_name, runner.id);
        removed += 1;
        console.log(`Removed offline ephemeral runner ${runner.name} from ${repo.full_name}`);
      }
    }
  }
  console.log(`Cleanup complete: removed ${removed} runner registration(s).`);
}

async function runForeground(args) {
  const { options, dryRun: shouldDryRun } = parseRunFlags(args);
  await preflightRun({ install: !shouldDryRun, only: options.only });
  if (shouldDryRun) return dryRun(options.only);

  if (options.only && (await detectFlavors(options.only)).length === 0) {
    console.warn(`No requested flavors are available: ${[...options.only].join(', ')}`);
  }

  const controller = new AbortController();
  let stopping = false;
  const stop = (signalName) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      event: 'shutdown_requested',
      signal: signalName,
    }));
    controller.abort();
  };

  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  await runDispatcher({ ...options, signal: controller.signal });
}

async function main() {
  const [command = '--help', ...args] = process.argv.slice(2);

  switch (command) {
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      return;
    case 'run':
      await runForeground(args);
      return;
    case 'status':
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      await status();
      return;
    case 'remove':
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      await remove();
      return;
    case 'service': {
      const [action, ...flags] = args;
      if (!['install', 'uninstall'].includes(action) || flags.some((flag) => flag !== '--no-elevate') || flags.length > 1) {
        throw new Error('Usage: runnerize service install|uninstall [--no-elevate]');
      }
      const options = { noElevate: flags.includes('--no-elevate') };
      if (action === 'install') await installService(options);
      else await uninstallService(options);
      return;
    }
    case 'guard': {
      const [action, ...flags] = args;
      if (!['install', 'uninstall', 'status'].includes(action)) {
        throw new Error('Usage: runnerize guard install [--shutdown-guard] | uninstall | status');
      }
      if (action === 'install') {
        if (flags.some((flag) => flag !== '--shutdown-guard') || flags.length > 1) {
          throw new Error('Usage: runnerize guard install [--shutdown-guard]');
        }
        await installGuard({ shutdownGuard: flags.includes('--shutdown-guard') });
      } else {
        if (flags.length) throw new Error(`Unexpected argument: ${flags[0]}`);
        if (action === 'uninstall') await uninstallGuard();
        else await guardStatus();
      }
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`runnerize: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
