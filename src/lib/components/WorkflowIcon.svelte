<script lang="ts">
  import {
    Bell,
    BookOpen,
    Bot,
    BrainCircuit,
    Braces,
    Database,
    Flag,
    GitBranch,
    Hourglass,
    LayoutDashboard,
    ListTodo,
    Merge,
    MessageCircleQuestionMark,
    MessageSquareText,
    Play,
    Repeat,
    SquareTerminal,
    Workflow,
    CircleDashed,
  } from '@lucide/svelte';
  let { type, size = 15 }: { type: string; size?: number } = $props();
  const icons = {
    start: Play,
    agent: Bot,
    message: MessageSquareText,
    read: BookOpen,
    condition: GitBranch,
    loop: Repeat,
    merge: Merge,
    wait: Hourglass,
    ask: MessageCircleQuestionMark,
    notify: Bell,
    set: Braces,
    screen: LayoutDashboard,
    screenAction: SquareTerminal,
    screenData: Database,
    workflow: Workflow,
    end: Flag,
    orchestrator: BrainCircuit,
    task: ListTodo,
  } as const;
  const Icon = $derived(icons[type as keyof typeof icons] ?? CircleDashed);
</script>

<Icon {size} aria-hidden="true" />
