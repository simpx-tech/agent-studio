import { arrangeSteps } from './workflow-layout';
import {
  definitionSchema,
  newNode,
  type Actor,
  type NodeType,
  type WorkflowDefinition,
  type WorkflowNode,
} from './workflow-model';

/**
 * Ready-made workflows (docs/WORKFLOWS.md), which the welcome of a new static workflow offers:
 * each a definition saved as any other, for the user to change.
 */
export const presets = [{ id: 'reviews', name: 'Review requests' }] as const;
export type PresetId = (typeof presets)[number]['id'];

/**
 * The pull requests waiting for your review on GitHub, one JSON object a line: those you are
 * asked to review, and those you reviewed that changed since (new commits, or comments and
 * replies from people after your latest). It runs `gh`, signed in where the trigger runs, and
 * `gh`'s own jq; a version changes with new commits and with others' new comments.
 */
export const REVIEWS_SCRIPT = `# Pull requests waiting for your review, one JSON object a line: those you are asked to review,
# and those you reviewed that changed since (new commits, or comments and replies from people
# after your latest). A version changes with new commits and with their new comments.
query='query($q: String!, $endCursor: String) {
  viewer { login }
  search(query: $q, type: ISSUE, first: 50, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        url number title isDraft headRefOid
        repository { nameWithOwner }
        author { login }
        reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } } } }
        comments(last: 100) { nodes { createdAt author { __typename login } } }
        reviews(last: 100) { nodes { submittedAt author { login } commit { oid } } }
        reviewThreads(last: 100) { nodes { comments(last: 1) { nodes { createdAt author { __typename login } } } } }
      }
    }
  }
}'
pick='.data.viewer.login as $me | .data.search.nodes[] | select(.url != null)
  | [.comments.nodes[], .reviewThreads.nodes[].comments.nodes[]] as $said
  | ([$said[] | select(.author.login == $me) | .createdAt]
      + [.reviews.nodes[] | select(.author.login == $me) | .submittedAt // ""] | max // "") as $mine
  | ([$said[] | select(.author != null and .author.login != $me and .author.__typename != "Bot")
      | .createdAt] | max // "") as $theirs
  | ([.reviews.nodes[] | select(.author.login == $me)] | last) as $review
  | ([.reviewRequests.nodes[].requestedReviewer.login] | index($me) != null) as $requested
  | select($requested or ($review != null and $review.commit.oid != .headRefOid) or $theirs > $mine)
  | {url, number, title, draft: .isDraft, repository: .repository.nameWithOwner,
     author: .author.login, head: .headRefOid, requested: $requested,
     reviewed: ($review.commit.oid // ""), version: "\\(.headRefOid) \\(\$theirs)"}'
for wanted in review-requested:@me reviewed-by:@me; do
  gh api graphql --paginate -f q="is:pr is:open archived:false -author:@me $wanted" \\
    -f query="$query" --jq "$pick"
done`;

const REVIEW_PROMPT = `A pull request you review on GitHub needs you: {{trigger.json.url}}
{{trigger.json.repository}} #{{trigger.json.number}} by {{trigger.json.author}}: {{trigger.json.title}}
Head commit {{trigger.json.head}}; the commit your last review covered: {{trigger.json.reviewed}}. Requested now: {{trigger.json.requested}}.

Use the GitHub CLI (gh). Read what changed since your last pass in this chat: new commits, and new comments and replies from other people. The first time, read the whole pull request, cloning the repository into this chat's folder when its code around the change matters. Review the change for correctness first, then for anything else worth raising.

Draft what to post, but post nothing yet: comments on lines, replies to the threads that ask you something, and a summary with your verdict (approve, comment or request changes). Show the draft in full. When nothing needs a response from me, reply with exactly: Nothing to post.`;

const POST_PROMPT = `Approved. Post what you drafted now with gh, as one review with its line comments and verdict, and the replies in their threads. Then reply with what you posted.`;

/** Review requests: a Watch trigger that finds pull requests waiting for your review. */
function reviews(actor: Actor, now: string): WorkflowDefinition {
  const taken: string[] = [];
  const step = (type: NodeType, key: string, title: string, config: Record<string, unknown>) => {
    const node: WorkflowNode = { ...newNode(type, { x: 0, y: 0 }, taken), key, title };
    node.config = { ...node.config, ...config };
    taken.push(key);
    return node;
  };
  const watch = step('start', 'prs', 'Pull requests to review', {
    trigger: 'watch',
    watch: {
      shell: 'bash',
      script: REVIEWS_SCRIPT,
      timeout: 0,
      every: 5,
      unit: 'minutes',
      id: 'url',
      version: 'version',
      initial: true,
    },
    // A pull request's next change waits for its run before it, which may wait for you.
    overlap: 'skip',
  });
  const review = step('agent', 'review', 'Review', {
    prompt: REVIEW_PROMPT,
    chatKey: '{{trigger.id}}',
    yours: true,
    title: '#{{trigger.json.number}} {{trigger.json.title}}',
  });
  const needed = step('condition', 'needed', 'Anything to post?', {
    left: '{{review.output}}',
    op: 'notContains',
    right: 'Nothing to post',
    ignoreCase: true,
  });
  const approve = step('confirm', 'approve', 'Post it?', {
    header: 'Review',
    question: 'Post your review of {{trigger.json.repository}} #{{trigger.json.number}}?',
    approve: 'Post',
    reject: 'Skip',
  });
  const post = step('message', 'post', 'Post the review', {
    target: 'step',
    step: 'review',
    text: POST_PROMPT,
    mode: 'next',
    wait: true,
  });
  const nodes = [watch, review, needed, approve, post];
  const edges = [
    { id: 'e-review', source: watch.id, sourcePort: 'out', target: review.id },
    { id: 'e-needed', source: review.id, sourcePort: 'out', target: needed.id },
    { id: 'e-approve', source: needed.id, sourcePort: 'true', target: approve.id },
    { id: 'e-post', source: approve.id, sourcePort: 'approved', target: post.id },
  ];
  const positions = arrangeSteps(nodes, edges);
  for (const node of nodes) node.position = positions.get(node.id) ?? node.position;
  return definitionSchema.parse({
    name: 'Review requests',
    description:
      'Reviews the pull requests waiting for you on GitHub and follows them up as they change.',
    graph: { nodes, edges },
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor,
  });
}

/** A ready-made workflow, as a new definition. */
export function presetDefinition(
  id: PresetId,
  actor: Actor,
  now = new Date().toISOString(),
): WorkflowDefinition {
  switch (id) {
    case 'reviews':
      return reviews(actor, now);
  }
}
