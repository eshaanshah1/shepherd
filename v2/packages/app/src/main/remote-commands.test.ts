// The join verbs — and above all the one a person actually uses to get a phone
// or a second Mac in.
//
// Joining means carrying a host, a port, a 64-character certificate pin and an
// 88-character root key to another device. Typed by hand that happens once and
// never again, so `remote.pair` has to hand back something scannable AND
// something pasteable, and both have to be the same payload.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: { showMessageBox: async () => ({ response: 0 }) } }));

// After the mock, so the module under test binds to it.
import { CommandRegistry, emptyGrants } from '@shepherd/core';
import { nullLogger } from '@shepherd/sdk';
import {
  generateMemberKey,
  netIdOf,
  parseJoinURI,
  REMOTE_PROTOCOL_VERSION,
  type NetSummary,
  type PairingPayload,
  type RemoteAPI,
} from '@shepherd/remote';
import { registerRemoteCommands, REMOTE_COMMANDS } from './remote-commands.ts';

const root = generateMemberKey().publicKey;
const net: NetSummary = { netId: netIdOf(root), name: 'Home', memberId: 'this-mac', founded: true };

const payload: PairingPayload = {
  host: '192.168.1.7',
  port: 8723,
  dataPort: 8724,
  pin: 'ab'.repeat(32),
  code: '424242',
  netId: net.netId,
  netName: net.name,
  rootPublicKey: root,
  protocolVersion: REMOTE_PROTOCOL_VERSION,
};

function remoteApi(over: Partial<RemoteAPI> = {}): RemoteAPI {
  return {
    serve: async () => ({ dispose: () => undefined }),
    showPairingCode: () => '424242',
    activeCode: () => '424242',
    pairingPayload: () => payload,
    nets: () => [net],
    activeNet: () => net,
    setActiveNet: () => undefined,
    createNet: () => net,
    joinNet: async () => net,
    invokeAt: async () => ({ views: [] }),
    // No verb reaches the data path, which is what this default asserts: the
    // command surface is control-only, and a test that needed a socket here
    // would be a test that found one that shouldn't exist.
    sessionSocket: () => Promise.reject(new Error('no data path in this test')),
    leaveNet: () => undefined,
    members: () => [],
    revoke: () => undefined,
    onJoinRequest: () => ({ dispose: () => undefined }),
    ...over,
  };
}

function harness(remote: RemoteAPI) {
  const registry = new CommandRegistry({ logger: nullLogger, grants: () => emptyGrants() });
  registerRemoteCommands({ remote, registry, log: nullLogger.child('session') });
  return async (command: string, args: unknown = {}) =>
    registry.invoke(command, args, { kind: 'user' });
}

describe('remote.pair', () => {
  it('hands back a link that parses back to the same facts', async () => {
    const invoke = await harness(remoteApi());
    const answer = await invoke(REMOTE_COMMANDS.pair);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    const value = answer.value as { uri: string; qr: string; pin: string };
    expect(parseJoinURI(value.uri)).toEqual(payload);
  });

  /**
   * The QR is the whole point of the verb for a phone: pointing a camera is the
   * only join flow nobody gives up on halfway.
   */
  it('renders the link as a QR block a camera can read', async () => {
    const invoke = await harness(remoteApi());
    const answer = await invoke(REMOTE_COMMANDS.pair);
    if (!answer.ok) throw new Error('pair failed');
    const { qr } = answer.value as { qr: string };
    expect(qr).toMatch(/[▀▄█]/u);

    /**
     * Measured with the colour escapes stripped, because they are what the
     * terminal consumes rather than what it draws — counting them says a 65-wide
     * QR is 1274 columns wide. What matters is that it fits an ordinary window:
     * a QR that wraps is not a QR, it is two halves of one.
     */
    const visible = qr.split('\n').map((line) => line.replace(/\u001b\[[\d;]*m/g, ''));
    expect(Math.max(...visible.map((line) => line.length))).toBeLessThan(100);
    expect(visible.length).toBeLessThan(50);
  });

  /**
   * The two ways this can fail look identical to a user — nothing to scan — and
   * call for opposite actions, so they must not collapse into one message.
   */
  it('says to create a net when there is no net', async () => {
    const invoke = await harness(remoteApi({ activeNet: () => undefined, pairingPayload: () => undefined }));
    const answer = await invoke(REMOTE_COMMANDS.pair);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error.message).toContain('createNet');
  });

  it('says it is not serving when there is a net but no listener', async () => {
    const invoke = await harness(remoteApi({ pairingPayload: () => undefined }));
    const answer = await invoke(REMOTE_COMMANDS.pair);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error.message).toContain('serving');
  });
});

describe('the net verbs', () => {
  it('creates, lists and switches nets', async () => {
    const created: string[] = [];
    const active: string[] = [];
    const invoke = await harness(
      remoteApi({
        createNet: (name) => {
          created.push(name);
          return net;
        },
        setActiveNet: (netId) => void active.push(netId),
      }),
    );

    await invoke(REMOTE_COMMANDS.createNet, { name: 'Home' });
    expect(created).toEqual(['Home']);

    const listed = await invoke(REMOTE_COMMANDS.nets);
    if (!listed.ok) throw new Error('nets failed');
    expect((listed.value as { active?: string }).active).toBe(net.netId);

    await invoke(REMOTE_COMMANDS.useNet, { net: net.netId });
    expect(active).toEqual([net.netId]);
  });

  it('lists members with no key material in the answer', async () => {
    const invoke = await harness(
      remoteApi({
        members: () => [
          { memberId: 'phone', name: 'Phone', addrs: ['10.0.0.2:8723'], admittedBy: 'this-mac', admittedAt: 1, updatedAt: 1 },
        ],
      }),
    );
    const answer = await invoke(REMOTE_COMMANDS.members);
    if (!answer.ok) throw new Error('members failed');
    expect(JSON.stringify(answer.value)).not.toContain('privateKey');
    expect((answer.value as Array<{ id: string }>)[0]?.id).toBe('phone');
  });
});
