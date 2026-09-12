import { resolve } from 'node:path';
import {
  createWorkspace,
  disableWorkspace,
  listManagedWorkspaces,
  editWorkspace,
  rotateWorkspace,
  workspaceRoleSchema,
} from './workspaces.ts';

const directory = resolve(process.env.AGENT_STUDIO_RELAY_DATA ?? '.relay-data');
const [command, value, ...extra] = process.argv.slice(2);
try {
  if (
    (command === 'role' ? extra.length !== 1 : extra.length !== 0) ||
    !['create', 'list', 'rotate', 'disable', 'role'].includes(command ?? '') ||
    (command === 'list' ? !!value : !value)
  ) {
    throw new Error(
      'Usage: node relay/manage.ts create "Name" | list | rotate <workspace-id> | disable <workspace-id> | role <workspace-id|owner> <admin|member>',
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
  } else if (command === 'role') {
    const role = workspaceRoleSchema.safeParse(extra[0]);
    if (!role.success) throw new Error('Role must be admin or member.');
    process.stdout.write(
      JSON.stringify(editWorkspace({ directory, id: value, role: role.data }), null, 2) + '\n',
    );
  } else process.stdout.write(JSON.stringify(listManagedWorkspaces(directory), null, 2) + '\n');
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : 'Workspace administration failed.') + '\n',
  );
  process.exitCode = 1;
}
