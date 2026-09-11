import { resolve } from 'node:path';
import {
  createWorkspace,
  disableWorkspace,
  listWorkspaces,
  rotateWorkspace,
} from './workspaces.ts';

const directory = resolve(process.env.AGENT_STUDIO_RELAY_DATA ?? '.relay-data');
const [command, value, ...extra] = process.argv.slice(2);
try {
  if (
    extra.length ||
    !['create', 'list', 'rotate', 'disable'].includes(command ?? '') ||
    (command === 'list' ? !!value : !value)
  ) {
    throw new Error(
      'Usage: node relay/manage.ts create "Name" | list | rotate <workspace-id> | disable <workspace-id>',
    );
  }
  if (command === 'create' || command === 'rotate') {
    const result =
      command === 'create'
        ? createWorkspace({ directory, name: value })
        : rotateWorkspace({ directory, id: value });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (command === 'disable') {
    process.stdout.write(
      JSON.stringify(disableWorkspace({ directory, id: value }), null, 2) + '\n',
    );
  } else process.stdout.write(JSON.stringify(listWorkspaces(directory), null, 2) + '\n');
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : 'Workspace administration failed.') + '\n',
  );
  process.exitCode = 1;
}
