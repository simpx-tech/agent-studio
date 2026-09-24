// A saved workspace shaped like a heavy real one, about 2.5 MB: two long chats among two dozen,
// with tool activity, progress comments, reasoning and recorded file diffs, plus a dozen ready
// connections on this computer. See docs/PERFORMANCE.md.
export const installation = {
  id: '11111111-1111-4111-8111-111111111111',
  computerId: '22222222-2222-4222-8222-222222222222',
  name: 'Desktop',
  platform: 'windows' as const,
};

const uuid = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const folder = 'C:\\Projects\\studio';
const sentence =
  'The change keeps the saved history intact and only updates the part of the workspace it owns.';

function diff(file: number) {
  const context = Array.from({ length: 40 }, (_, i) => ` const value${i} = read(${file}, ${i});`);
  const removed = Array.from({ length: 12 }, (_, i) => `-  return legacy(value${i}, ${file});`);
  const added = Array.from({ length: 24 }, (_, i) => `+  return current(value${i % 12}, ${file});`);
  const lines = [...context, ...removed, ...added];
  return { oldStart: 10, oldLines: 52, newStart: 10, newLines: 64, lines };
}

function reply(conversation: number, index: number, settings: object, createdAt: string) {
  const n = conversation * 100 + index;
  const blocks: object[] = [];
  let order = 0;
  for (let step = 0; step < 6; step++) {
    blocks.push({
      type: 'reasoning',
      id: `reasoning-${n}-${step}`,
      revision: 1,
      text: `I should check module ${step} before editing it. ${sentence} ${sentence}`,
      truncated: false,
    });
    blocks.push({
      type: 'activity',
      text: `Checking module ${step}. ${sentence} ${sentence}`,
      progress: { id: `progress-${n}-${step}`, revision: 1 },
      order: order++,
    });
    for (let call = 0; call < 3; call++) {
      const path = `${folder}\\src\\lib\\module-${step}-${call}.ts`;
      const tool =
        call === 0
          ? { name: 'Read', operation: 'read', path, facts: [{ label: 'Lines', value: '1-240' }] }
          : call === 1
            ? { name: 'Write', operation: 'edit', path, facts: [] }
            : {
                name: 'Run command',
                operation: 'command',
                commandRun: true,
                detail: `Run the unit tests for module ${step}`,
                facts: [{ label: 'Exit code', value: '0' }],
              };
      blocks.push({
        type: 'activity',
        text: tool.name,
        tool: {
          id: `tool-${n}-${step}-${call}`,
          revision: 3,
          category: 'tool',
          status: 'complete',
          elapsedMs: 1200,
          sources: [],
          agents: [],
          ...tool,
        },
        order: order++,
      });
    }
  }
  blocks.push({
    type: 'markdown',
    text: `## Reply ${index + 1}\n\n${sentence}\n\n\`\`\`ts\nexport function update(value: number) {\n  return value + ${n};\n}\n\`\`\`\n\n${sentence} ${sentence}`,
  });
  return {
    id: uuid(0x30 + conversation, 2 * index + 1),
    role: 'assistant',
    blocks,
    status: 'complete',
    createdAt,
    durationMs: 95_400,
    modelName: 'Opus',
    settings,
    runId: uuid(0x60 + conversation, index),
    usage: {
      input: 120_000,
      output: 4_000,
      cachedInput: 100_000,
      contextInput: 120_000,
      contextWindow: 1_000_000,
      costUsd: 0.42,
      scope: 'reply',
    },
    // Three replies in five record their file edits, which hold most of a real workspace's bytes.
    ...(n % 5 < 3
      ? {
          fileChanges: {
            revision: 1,
            limited: false,
            edits: Array.from({ length: 13 }, (_, file) => ({
              id: `edit-${n}-${file}`,
              files: [
                {
                  path: `${folder}\\src\\lib\\module-${file}.ts`,
                  kind: 'modified',
                  hunks: [diff(file)],
                },
              ],
            })),
          },
        }
      : {}),
  };
}

export function largeWorkspace() {
  const provider = (i: number) => (i < 6 ? 'claude' : i < 11 ? 'codex' : 'gemini');
  const accounts = Array.from({ length: 12 }, (_, i) => ({
    id: uuid(1, i),
    name: `Account ${i + 1}`,
    provider: provider(i),
    purpose: 'personal',
  }));
  const connections = accounts.map((account, i) => ({
    id: uuid(2, i),
    environmentId: installation.id,
    accountId: account.id,
    profile: [0, 6, 11].includes(i) ? 'existing' : 'isolated',
  }));
  const settings = {
    provider: 'claude',
    model: 'opus',
    reasoning: 'high',
    instructions: '',
    connectionId: connections[0].id,
  };
  // 64 replies: two chats of 17, four of 3 and eighteen of 1.
  const replies = (i: number) => (i < 2 ? 17 : i < 6 ? 3 : 1);
  const conversations = Array.from({ length: 24 }, (_, i) => {
    const createdAt = new Date(Date.UTC(2026, 8, 1 + (i % 20), 9)).toISOString();
    return {
      id: uuid(3, i),
      location: {
        computerId: installation.computerId,
        environmentId: installation.id,
        path: [folder, 'C:\\Projects\\tools', 'C:\\Projects\\archive'][i % 3],
      },
      settings,
      title: i === 0 ? 'Long performance chat' : `Saved chat ${i + 1}`,
      titleStatus: 'generated',
      createdAt,
      updatedAt: createdAt,
      messages: Array.from({ length: replies(i) }, (_, index) => [
        {
          id: uuid(0x30 + i, 2 * index),
          role: 'user',
          blocks: [{ type: 'markdown', text: `Please update module ${index}. ${sentence}` }],
          status: 'complete',
          createdAt,
        },
        reply(i, index, settings, createdAt),
      ]).flat(),
    };
  });
  return {
    version: 3,
    fleet: {
      computers: [{ id: installation.computerId, name: installation.name }],
      environments: [
        {
          id: installation.id,
          computerId: installation.computerId,
          name: installation.name,
          platform: installation.platform,
        },
      ],
      accounts,
      connections,
    },
    preferences: {
      lastProvider: 'claude',
      connectionByProvider: { claude: connections[0].id },
      modelByProvider: { claude: 'opus' },
      reasoningByProvider: { claude: { opus: 'high' } },
    },
    conversations,
  };
}
