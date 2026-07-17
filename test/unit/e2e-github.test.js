import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowYaml } from '../helpers/e2e-github.js';

test('workflowYaml renders every caller-supplied runner label', () => {
  const labels = ['self-hosted', 'linux', 'x64', 'e2e-run-123'];
  const yaml = workflowYaml('runnerize-e2e-run-123', 'marker', labels);

  assert.match(yaml, /runs-on: \['self-hosted', 'linux', 'x64', 'e2e-run-123'\]/);
  for (const label of labels) assert.match(yaml, new RegExp(`'${label}'`));
});

test('workflowYaml does not add generic labels independently of the caller', () => {
  const yaml = workflowYaml('branch', 'marker', ['self-hosted', 'e2e-only']);

  assert.match(yaml, /runs-on: \['self-hosted', 'e2e-only'\]/);
  assert.doesNotMatch(yaml, /'linux'|'x64'/);
});

test('workflowYaml quotes labels safely and rejects multiline labels', () => {
  const yaml = workflowYaml('branch', 'marker', ["self'hosted", 'e2e-only']);
  assert.match(yaml, /runs-on: \['self''hosted', 'e2e-only'\]/);
  assert.throws(() => workflowYaml('branch', 'marker', ['self-hosted', 'bad\nlabel']), TypeError);
});
