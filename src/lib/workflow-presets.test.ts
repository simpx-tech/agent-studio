import { describe, expect, it } from 'vitest';
import { graphIssues, nodeConfig, triggerOf } from './workflow-model';
import { REVIEWS_SCRIPT, presetDefinition, presets } from './workflow-presets';

describe('ready-made workflows', () => {
  it('Review requests watches pull requests and reviews each in a chat of its own', () => {
    expect(presets.map((p) => p.id)).toEqual(['reviews']);
    const definition = presetDefinition('reviews', { kind: 'user' }, '2026-11-25T12:00:00Z');
    expect(definition.name).toBe('Review requests');
    // Nothing keeps it from running as saved.
    expect(graphIssues(definition.graph).filter((i) => i.blocking)).toEqual([]);
    expect(graphIssues(definition.graph)).toEqual([]);
    const [watch, review, needed, approve, post] = definition.graph.nodes;
    expect(triggerOf(watch)).toBe('watch');
    expect(nodeConfig(watch, 'start')).toMatchObject({
      overlap: 'skip',
      watch: { shell: 'bash', every: 5, unit: 'minutes', id: 'url', version: 'version', initial: true },
    });
    expect(nodeConfig(watch, 'start').watch.script).toBe(REVIEWS_SCRIPT);
    expect(nodeConfig(review, 'agent')).toMatchObject({ chatKey: '{{trigger.id}}', yours: true });
    expect(nodeConfig(review, 'agent').prompt).toContain('post nothing yet');
    expect(nodeConfig(needed, 'condition')).toMatchObject({
      left: '{{review.output}}',
      op: 'notContains',
      right: 'Nothing to post',
    });
    expect(nodeConfig(approve, 'confirm').approve).toBe('Post');
    expect(nodeConfig(post, 'message')).toMatchObject({ target: 'step', step: 'review' });
    expect(definition.graph.edges.map((e) => [e.source, e.sourcePort, e.target])).toEqual([
      [watch.id, 'out', review.id],
      [review.id, 'out', needed.id],
      [needed.id, 'true', approve.id],
      [approve.id, 'approved', post.id],
    ]);
    // Laid out from top to bottom.
    const ys = definition.graph.nodes.map((n) => n.position.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it('asks gh only for what needs you, as one JSON object a line', () => {
    // Its jq keeps its interpolations and line continuations as bash reads them.
    expect(REVIEWS_SCRIPT).toContain('version: "\\(.headRefOid) \\($theirs)"');
    expect(REVIEWS_SCRIPT).toContain('-author:@me $wanted" \\\n');
    expect(REVIEWS_SCRIPT).toContain('for wanted in review-requested:@me reviewed-by:@me; do');
    expect(REVIEWS_SCRIPT).not.toContain('\r');
  });
});
