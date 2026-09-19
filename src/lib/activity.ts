import { z } from 'zod';
import { accountUsageSchema, latestAccountUsage } from './spend.ts';
import type { ContentBlock, Message, RunEvent } from './domain';
import { fileChangesSchema, latestFileChanges } from './file-changes.ts';
import { planSchema } from './plans.ts';
import { visualizationSchema, mergeVisualizations } from './visualizations.ts';
import { questionRequestSchema, mergeQuestions } from './questions.ts';
import { workflowProgressSchema, nativeWorkflowsSchema } from './workflows.ts';
import { reasoningBlockSchema, maxReasoningBlocks, mergeReasoningBlocks } from './reasoning.ts';

export const activityStatusSchema = z.enum([
  'running',
  'complete',
  'error',
  'cancelled',
  'unknown',
]);
export const toolActivitySchema = z.object({
  id: z.string().max(240),
  revision: z.number().int().nonnegative(),
  category: z.enum(['skill', 'search', 'agent', 'tool']),
  name: z.string().max(200),
  status: activityStatusSchema,
  parentId: z.string().max(240).optional(),
  detail: z.string().max(4096).optional(),
  query: z.string().max(2048).optional(),
  path: z.string().max(4096).optional(),
  operation: z.string().max(40).optional(),
  commandRun: z.boolean().optional(),
  facts: z
    .array(z.object({ label: z.string().max(80), value: z.string().max(4096) }))
    .max(12)
    .default([]),
  sources: z
    .array(z.object({ title: z.string().max(300), url: z.string().max(2048) }))
    .max(12)
    .default([]),
  agents: z
    .array(
      z.object({
        id: z.string().max(240),
        agentId: z.string().max(240).optional(),
        name: z.string().max(200),
        status: activityStatusSchema,
        parentId: z.string().max(240).optional(),
        task: z.string().max(2048).optional(),
        result: z.string().max(8000).optional(),
      }),
    )
    .max(64)
    .default([]),
});
export type ToolActivity = Omit<z.infer<typeof toolActivitySchema>, 'facts'> & {
  facts?: z.infer<typeof toolActivitySchema>['facts'];
};

export function safeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {
    /* Invalid provider links are never actionable. */
  }
}

export function mergeActivityBlocks(left: ContentBlock[], right: ContentBlock[]): ContentBlock[] {
  const result = [...left];
  const reasoning = mergeReasoningBlocks(
    left.filter((b) => b.type === 'reasoning'),
    right.filter((b) => b.type === 'reasoning'),
  );
  for (const block of reasoning) {
    const index = result.findIndex((b) => b.type === 'reasoning' && b.id === block.id);
    if (index >= 0) result[index] = block;
    else result.push(block);
  }
  for (const block of right) {
    if (block.type !== 'activity') continue;
    const tool = block.tool;
    const index = result.findIndex(
      (b) =>
        b.type === 'activity' &&
        (tool
          ? b.tool?.id === tool.id
          : block.progress
            ? b.progress?.id === block.progress.id
            : !b.tool && !b.progress && b.text === block.text),
    );
    if (index < 0) result.push(block);
    else if (tool && tool.revision > ((result[index] as typeof block).tool?.revision ?? -1))
      result[index] = block;
    else if (
      block.progress &&
      block.progress.revision > ((result[index] as typeof block).progress?.revision ?? -1)
    )
      result[index] = block;
  }
  return result;
}

export function applyRunEvent(message: Message, event: RunEvent) {
  if (event.kind === 'reasoning') {
    const parsed = reasoningBlockSchema.safeParse({ ...event, type: 'reasoning' });
    if (message.role !== 'assistant' || !parsed.success) return;
    message.blocks = mergeActivityBlocks(message.blocks, [parsed.data]);
  } else if (event.kind === 'accountusage') {
    const parsed = accountUsageSchema.safeParse(event.accountUsage);
    if (message.role === 'assistant' && parsed.success && message.runId === parsed.data.runId)
      message.accountUsage = latestAccountUsage(message.accountUsage, parsed.data);
  } else if (event.kind === 'filechanges') {
    const parsed = fileChangesSchema.safeParse(event.fileChanges);
    if (message.role === 'assistant' && parsed.success)
      message.fileChanges = latestFileChanges(message.fileChanges, parsed.data);
  } else if (event.kind === 'question') {
    const parsed = questionRequestSchema.safeParse(event.question);
    if (message.role === 'assistant' && parsed.success)
      message.questions = mergeQuestions(message.questions, [parsed.data]);
  } else if (event.kind === 'visualization') {
    const parsed = visualizationSchema.safeParse(event.visualization);
    if (message.role === 'assistant' && parsed.success)
      message.visualizations = mergeVisualizations(message.visualizations, [parsed.data]);
  } else if (event.kind === 'nativeworkflow') {
    const parsed = nativeWorkflowsSchema.safeParse(event.nativeWorkflows);
    if (parsed.success && parsed.data.revision > (message.nativeWorkflows?.revision ?? -1))
      message.nativeWorkflows = parsed.data;
  } else if (event.kind === 'plan') {
    const parsed = planSchema.safeParse(event.plan);
    if (parsed.success && parsed.data.revision > (message.plan?.revision ?? -1))
      message.plan = parsed.data;
  } else if (event.kind === 'workflow') {
    const parsed = workflowProgressSchema.safeParse(event.workflow);
    if (parsed.success && parsed.data.revision > (message.workflow?.revision ?? -1))
      message.workflow = parsed.data;
  } else if (event.kind === 'tool') {
    const parsed = toolActivitySchema.safeParse(event.tool);
    if (!parsed.success) return;
    const tool = parsed.data;
    const block = message.blocks.find((b) => b.type === 'activity' && b.tool?.id === tool.id);
    if (block?.type === 'activity') {
      if (tool.revision > (block.tool?.revision ?? -1)) {
        block.tool = tool;
        block.text = tool.name;
      }
    } else if (message.blocks.filter((b) => b.type === 'activity' && b.tool).length < 201) {
      message.blocks.push({
        type: 'activity',
        text: tool.name,
        tool,
        order: message.blocks.length,
      });
    }
  } else if (event.kind === 'progress') {
    if (
      typeof event.id !== 'string' ||
      event.id.length > 240 ||
      !Number.isInteger(event.revision) ||
      event.revision! < 0 ||
      typeof event.text !== 'string' ||
      event.text.length > 32000
    )
      return;
    const block = message.blocks.find((b) => b.type === 'activity' && b.progress?.id === event.id);
    const progress = { id: event.id, revision: event.revision! };
    if (block?.type === 'activity') {
      if (progress.revision > (block.progress?.revision ?? -1)) {
        block.text = event.text;
        block.progress = progress;
      }
    } else if (message.blocks.filter((b) => b.type === 'activity' && b.progress).length < 64) {
      message.blocks.push({
        type: 'activity',
        text: event.text,
        progress,
        order: message.blocks.length,
      });
    }
  } else if (event.kind === 'text') {
    const block = message.blocks.find((b) => b.type === 'markdown');
    if (block) block.text = event.text ?? '';
    else message.blocks.push({ type: 'markdown', text: event.text ?? '' });
  } else if (event.kind === 'activity') {
    if (
      !message.blocks.some(
        (b) => b.type === 'activity' && !b.tool && !b.progress && b.text === event.text,
      ) &&
      message.blocks.filter((b) => b.type === 'activity' && !b.tool && !b.progress).length < 30
    )
      message.blocks.push({
        type: 'activity',
        text: event.text ?? '',
        order: message.blocks.length,
      });
  } else if (event.kind === 'usage') {
    if (message.usage?.revision != null && (event.revision ?? -1) <= message.usage.revision) return;
    const { kind: _kind, text: _text, tool: _tool, id: _id, revision: _revision, ...usage } = event;
    message.usage = { ...usage, ...(event.revision != null ? { revision: event.revision } : {}) };
  } else if (event.kind === 'error') message.error = event.text;
}

// Keep provider-reported state intact on disk. A stopped/disconnected reply must not
// present its last running snapshot as still executing, or invent a successful result.
export function visibleActivityStatus(
  status: ToolActivity['status'],
  replyStatus: Message['status'],
) {
  return status === 'running' && replyStatus !== 'running'
    ? replyStatus === 'cancelled'
      ? 'cancelled'
      : 'unknown'
    : status;
}

export function retainRunEvent(events: RunEvent[], event: RunEvent) {
  if (event.kind === 'reasoning') {
    const parsed = reasoningBlockSchema.safeParse({ ...event, type: 'reasoning' });
    if (!parsed.success) return;
    const { type: _type, ...data } = parsed.data;
    const next: RunEvent = { kind: 'reasoning', ...data };
    const index = events.findIndex((e) => e.kind === 'reasoning' && e.id === next.id);
    if (index >= 0) {
      if (next.revision! > (events[index].revision ?? -1)) events[index] = next;
    } else if (events.filter((e) => e.kind === 'reasoning').length < maxReasoningBlocks)
      events.push(next);
    return;
  }
  if (event.kind === 'usage') {
    const previous = events.find((e) => e.kind === 'usage');
    if (previous?.revision != null && (event.revision ?? -1) <= previous.revision) return;
  }
  if (event.kind === 'accountusage') {
    const parsed = accountUsageSchema.safeParse(event.accountUsage);
    if (!parsed.success) return;
    const index = events.findIndex((e) => e.kind === 'accountusage');
    if (index < 0) events.push({ kind: 'accountusage', accountUsage: parsed.data });
    else
      events[index] = {
        kind: 'accountusage',
        accountUsage: latestAccountUsage(events[index].accountUsage, parsed.data),
      };
    return;
  }
  if (event.kind === 'filechanges') {
    const parsed = fileChangesSchema.safeParse(event.fileChanges);
    if (!parsed.success) return;
    const index = events.findIndex((e) => e.kind === 'filechanges');
    if (index < 0) events.push({ kind: 'filechanges', fileChanges: parsed.data });
    else if (parsed.data.revision > (events[index].fileChanges?.revision ?? -1))
      events[index] = { kind: 'filechanges', fileChanges: parsed.data };
    return;
  }
  if (event.kind === 'question') {
    const parsed = questionRequestSchema.safeParse(event.question);
    if (!parsed.success) return;
    const index = events.findIndex(
      (e) => e.kind === 'question' && e.question?.id === parsed.data.id,
    );
    if (index >= 0) {
      if (parsed.data.revision > (events[index].question?.revision ?? -1)) events[index] = event;
    } else if (events.filter((e) => e.kind === 'question').length < 16) events.push(event);
    return;
  }
  if (event.kind === 'visualization') {
    const parsed = visualizationSchema.safeParse(event.visualization);
    if (!parsed.success) return;
    const index = events.findIndex(
      (e) => e.kind === 'visualization' && e.visualization?.id === parsed.data.id,
    );
    if (index >= 0) {
      if (parsed.data.revision > (events[index].visualization?.revision ?? -1))
        events[index] = event;
    } else if (events.filter((e) => e.kind === 'visualization').length < 12) events.push(event);
    return;
  }
  const index =
    event.kind === 'tool'
      ? events.findIndex((e) => e.kind === 'tool' && e.tool?.id === event.tool?.id)
      : event.kind === 'progress'
        ? events.findIndex((e) => e.kind === 'progress' && e.id === event.id)
        : event.kind === 'activity'
          ? events.findIndex((e) => e.kind === 'activity' && e.text === event.text)
          : events.findIndex((e) => e.kind === event.kind);
  if (index >= 0) {
    if (
      event.kind === 'nativeworkflow'
        ? (event.nativeWorkflows?.revision ?? -1) > (events[index].nativeWorkflows?.revision ?? -1)
        : event.kind === 'plan'
          ? (event.plan?.revision ?? -1) > (events[index].plan?.revision ?? -1)
          : event.kind === 'workflow'
            ? (event.workflow?.revision ?? -1) > (events[index].workflow?.revision ?? -1)
            : event.kind === 'progress'
              ? (event.revision ?? -1) > (events[index].revision ?? -1)
              : event.kind !== 'tool' ||
                (event.tool?.revision ?? -1) > (events[index].tool?.revision ?? -1)
    )
      events[index] = event;
  } else if (
    events.filter((e) => e.kind !== 'reasoning').length < 336 &&
    (event.kind !== 'progress' || events.filter((e) => e.kind === 'progress').length < 64) &&
    (event.kind !== 'activity' || events.filter((e) => e.kind === 'activity').length < 30)
  )
    events.push(event);
}

export function activityCounts(tools: ToolActivity[]) {
  const unique = [...new Map(tools.map((t) => [t.id, t])).values()];
  const calls = unique.filter((t) => t.category !== 'agent' && t.id !== 'activity-limit');
  return {
    calls: calls.length,
    searches: calls.filter((t) => t.category === 'search' && t.name !== 'Open web page').length,
    agents: new Set(unique.flatMap((t) => t.agents.map((a) => a.agentId ?? a.id))).size,
    runs: calls.filter((t) => t.commandRun || t.name === 'Run command' || t.name === 'Bash').length,
    limited: unique.some((t) => t.id === 'activity-limit'),
  };
}
