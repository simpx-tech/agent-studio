import type { NativeWorkflows } from '../src/lib/workflows';
export function nativeWorkflowFixture(): NativeWorkflows {
  return {
    revision: 3,
    runs: [
      {
        id: 'call',
        taskId: 'native-task',
        runId: 'wf-fixture',
        name: 'audit-routes',
        status: 'running',
        description: 'Review the routes',
        scriptPath: '',
        error: '',
        phases: [{ index: 1, title: 'Review' }],
        agents: [
          {
            index: 1,
            id: 'agent-1',
            label: 'Route A',
            phaseIndex: 1,
            model: 'Sonnet',
            status: 'complete',
            tokens: 20,
            durationMs: 1000,
            result: 'Route verified',
          },
          {
            index: 2,
            id: 'agent-2',
            label: 'Route B',
            phaseIndex: 1,
            model: 'Sonnet',
            status: 'running',
            tokens: null,
            durationMs: null,
            result: '',
          },
        ],
        tokens: 20,
        durationMs: 1200,
        limited: false,
      },
    ],
  };
}
