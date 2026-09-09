import { describe, expect, it } from 'vitest';
import {
  emptyFleet,
  registerInstallation,
  registerWslEnvironments,
  reconcileDiscoveredWsl,
  fleetSchema,
  type Installation,
} from './fleet';
const windows = (): Installation => ({
  id: crypto.randomUUID(),
  computerId: crypto.randomUUID(),
  name: 'Desktop',
  platform: 'windows',
});
describe('WSL inventory', () => {
  it('persists one stable distribution under Windows without granting an execution connection', () => {
    const host = windows(),
      fleet = emptyFleet();
    registerInstallation(fleet, host);
    const discovery = {
      distributions: [{ id: crypto.randomUUID(), name: 'Ubuntu', running: true }],
      warning: null,
    };
    registerWslEnvironments(fleet, host, discovery);
    registerWslEnvironments(fleet, host, discovery);
    expect(fleet.computers).toHaveLength(1);
    expect(fleet.environments).toHaveLength(2);
    expect(fleet.connections).toEqual([]);
    expect(fleet.environments[1]).toMatchObject({
      discoveredOn: host.id,
      computerId: host.computerId,
      distribution: 'Ubuntu',
    });
    expect(fleetSchema.parse(JSON.parse(JSON.stringify(fleet)))).toEqual(fleet);
    registerWslEnvironments(fleet, host, { distributions: [], warning: null });
    expect(fleet.environments).toHaveLength(2); // Keep inventory through temporary unavailability.
  });
  it('keeps Windows and detected distributions together after regrouping', () => {
    const host = windows(),
      fleet = emptyFleet();
    registerInstallation(fleet, host);
    const discovery = {
      distributions: [{ id: crypto.randomUUID(), name: 'Ubuntu', running: false }],
      warning: null,
    };
    registerWslEnvironments(fleet, host, discovery);
    const group = crypto.randomUUID();
    fleet.computers.push({ id: group, name: 'My desktop' });
    fleet.environments[0].computerId = group;
    registerWslEnvironments(fleet, host, discovery);
    expect(fleet.environments.map((e) => e.computerId)).toEqual([group, group]);
  });
  it('reconciles a connected WSL installation after grouping without merging another computer’s Ubuntu', () => {
    const host = windows(),
      fleet = emptyFleet();
    registerInstallation(fleet, host);
    const discovery = {
      distributions: [{ id: crypto.randomUUID(), name: 'Ubuntu', running: true }],
      warning: null,
    };
    registerWslEnvironments(fleet, host, discovery);
    const linux: Installation = {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'WSL host',
      platform: 'wsl',
      distribution: 'Ubuntu',
    };
    registerInstallation(fleet, linux);
    reconcileDiscoveredWsl(fleet);
    expect(fleet.environments).toHaveLength(3);
    fleet.environments.find((e) => e.id === linux.id)!.computerId = host.computerId;
    reconcileDiscoveredWsl(fleet);
    registerWslEnvironments(fleet, host, discovery);
    expect(fleet.environments).toHaveLength(2);
    expect(fleet.environments.find((e) => e.id === linux.id)?.discoveredOn).toBe(host.id);
    expect(fleet.environments.some((e) => e.id === discovery.distributions[0].id)).toBe(false);
  });
});
