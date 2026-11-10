import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { handleRpc } from './index.js';

const guide = await readFile(new URL('./skill.md', import.meta.url), 'utf8');

test('unauthenticated MCP tool, resource and prompt deliver the bundled guide', async () => {
  const call = await handleRpc({ id: 1, method: 'tools/call', params: { name: 'bard_get_skill', arguments: {} } });
  assert.equal(JSON.parse(call.result.content[0].text).content, guide);
  const resource = await handleRpc({ id: 2, method: 'resources/read', params: { uri: 'bard://skill' } });
  assert.equal(resource.result.contents[0].text, guide);
  const prompt = await handleRpc({ id: 3, method: 'prompts/get', params: { name: 'getting-started' } });
  assert.equal(prompt.result.messages[0].content.text.split(guide).length, 2, 'embed the same guide exactly once');
});

test('an isolated package cannot fall back to recursive guide pointers', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'bard-skill-package-'));
  const core = path.join(fixtureRoot, 'shared', 'mcp');
  try {
    await mkdir(core, { recursive: true });
    await mkdir(path.join(fixtureRoot, 'mcp'));
    await writeFile(path.join(fixtureRoot, 'AGENT_SKILL.md'), 'Call bard_get_skill to read the guide.');
    await writeFile(path.join(fixtureRoot, 'mcp', 'SKILL.md'), 'Call bard_get_skill to read the guide.');
    await copyFile(new URL('./index.js', import.meta.url), path.join(core, 'index.mjs'));
    const moduleUrl = pathToFileURL(path.join(core, 'index.mjs')).href;
    await assert.rejects(import(moduleUrl), { code: 'ENOENT' });
    await writeFile(path.join(core, 'skill.md'), '\n ');
    await assert.rejects(import(`${moduleUrl}?empty`), /guide is empty/);
    await writeFile(path.join(core, 'skill.md'), guide);
    const packaged = await import(`${moduleUrl}?complete`);
    const result = await packaged.handleRpc({ id: 4, method: 'resources/read', params: { uri: 'bard://skill' } });
    assert.equal(result.result.contents[0].text, guide);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
