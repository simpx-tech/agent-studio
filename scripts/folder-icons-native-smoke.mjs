// Opt-in isolated native check: the small models of the signed-in Claude and Codex CLI logins
// choose catalog icons for a few project folders. Ten small requests; no chat is started.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { nativePage } from './native-page.mjs';

const page = await nativePage(Number(process.env.FOLDER_ICONS_QA_PORT ?? 9541));
const catalog = JSON.parse(await readFile('src/lib/folder-icons.json', 'utf8'));
const names = new Set(catalog.categories.flatMap((category) => category.icons.map(([n]) => n)));
const folders = [
  ['Github/agent-studio', 'Show each account usage in the agent picker'],
  ['Documents/Unreal Projects/Bluevox', 'The voxel terrain shader flickers at chunk borders'],
  ['Documents/Github/hoard', 'Add a page that lists every board game I own'],
  ['Users/me/blender-lab', ''],
];
const results = [];
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.folder-icons-qa',
  );
  for (const provider of ['claude', 'codex'])
    for (const [folder, firstMessage] of folders) {
      const started = Date.now();
      const result = await page.invoke('generate_folder_icon', {
        conversationId: crypto.randomUUID(),
        provider,
        folder,
        firstMessage,
      });
      assert(
        names.has(result.icon),
        `${provider} chose ${result.icon}, which is not in the catalog`,
      );
      assert.equal(result.provider, provider);
      results.push({
        provider,
        model: result.model,
        folder,
        icon: result.icon,
        ms: Date.now() - started,
      });
      console.log(`${provider} (${result.model}): ${folder} -> ${result.icon}`);
    }
  // Two choices at a time; a third waits for its turn. The page settles them, since a rejected
  // command's message does not cross the debugging protocol.
  const concurrent = await page.evaluate(async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        window.__TAURI_INTERNALS__.invoke('generate_folder_icon', {
          conversationId: crypto.randomUUID(),
          provider: 'claude',
          folder: 'Github/questlog',
          firstMessage: 'Track the quests of my tabletop campaign',
        }),
      ),
    );
    return settled.map((r) => (r.status === 'fulfilled' ? r.value.icon : `error: ${r.reason}`));
  });
  results.push({ provider: 'claude', folder: 'Github/questlog', concurrent });
  console.log(`claude, three at once: ${concurrent.join(', ')}`);
  assert.equal(concurrent.filter((r) => /already busy/.test(r)).length, 1);
  assert.equal(concurrent.filter((r) => names.has(r)).length, 2);
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
  await mkdir('artifacts', { recursive: true });
  await writeFile(
    'artifacts/folder-icons-native.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
  );
}
