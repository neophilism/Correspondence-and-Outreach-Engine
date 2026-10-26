import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parsePrRegistry } from '../registry/pr-contract.mjs';

const body = await readFile(new URL('../registry/prs.json', import.meta.url), 'utf8');
const registry = JSON.parse(body);

test('canonical registry records one foundation mapped to actual PR without fabricated observations', () => {
  const parsed = parsePrRegistry(body, registry.repository);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].sourceItemId, 'COE-001');
  assert.deepEqual(parsed.items[0].numbers, [1]);
  assert.deepEqual(parsed.pullRequests, []);
});

test('incomplete PR observations are rejected rather than inferred from a URL', () => {
  const invalid = structuredClone(registry);
  invalid.pullRequests = [{ number: 1, state: 'open', url: `https://github.com/${registry.repository}/pull/1` }];
  assert.throws(() => parsePrRegistry(JSON.stringify(invalid), registry.repository), /Invalid.*GitHub PR record/);
});

test('registry cannot claim another repository or inflate planned work', () => {
  assert.throws(() => parsePrRegistry(body, 'other/repository'), /Invalid repository identity/);
  const invalid = structuredClone(registry);
  invalid.plannedPrCount = 2;
  assert.throws(() => parsePrRegistry(JSON.stringify(invalid), registry.repository), /Invalid repository identity/);
});
