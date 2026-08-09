// The daemon as a REAL detached process: spawn it the way the app will, create a
// session over the socket, kill the client, and require the pty to still be there.
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = '/Users/eshaan/.shepherd/v2/tasks/i-m-thinking-we-can-move-on-to-adding-the-remote-library-i-t/shepherd/v2';
const require = createRequire(join(ROOT, 'packages/app/package.json'));
const electron = require('electron');
const { encodeJsonFrame, encodeByteFrame, FrameDecoder, REQUEST, RESPONSE, PROTOCOL_VERSION } =
  await import(join(ROOT, 'packages/core/src/session/protocol.ts'));

const sock = join(mkdtempSync(join(tmpdir(), 'shepherdd-')), 'session.sock');
const daemon = spawn(electron, [join(ROOT, 'packages/daemon/src/main.ts'), `--socket=${sock}`], {
  detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined },
});
daemon.unref();
let log = '';
daemon.stdout.on('data', (d) => { log += d; });
daemon.stderr.on('data', (d) => { log += d; });

await new Promise((r) => {
  const t = setInterval(() => { if (log.includes('shepherdd: ready')) { clearInterval(t); r(); } }, 50);
  setTimeout(() => { clearInterval(t); r(); }, 15000);
});
if (!log.includes('shepherdd: ready')) { console.log('FAIL daemon never announced ready:\n' + log); process.exit(1); }
console.log('ok — daemon announced ready:', log.trim().split('\n').pop());

const socket = connect(sock);
const dec = new FrameDecoder();
const seen = [];
socket.on('data', (c) => { seen.push(...dec.feed(new Uint8Array(c)).frames); });
await new Promise((r) => socket.once('connect', r));

const wait = async (p, label, ms = 8000) => {
  const end = Date.now() + ms;
  while (!p()) { if (Date.now() > end) throw new Error('timeout: ' + label); await new Promise((r) => setTimeout(r, 25)); }
};
const reply = (seq) => seen.find((f) => (f.kind === RESPONSE.ok || f.kind === RESPONSE.err) && f.json?.seq === seq);

socket.write(encodeJsonFrame(REQUEST.hello, { seq: 1, version: PROTOCOL_VERSION }));
await wait(() => reply(1), 'hello');
const daemonPid = reply(1).json.value.pid;
console.log('ok — handshake, daemon pid', daemonPid);

socket.write(encodeJsonFrame(REQUEST.create, { seq: 2, spec: { cwd: '/tmp', command: '/bin/sh', args: [] } }));
await wait(() => reply(2), 'create');
const id = reply(2).json.value.id;
const ptyPid = reply(2).json.value.pid;
console.log('ok — session', id.slice(0, 8), 'pty pid', ptyPid);

socket.write(encodeJsonFrame(REQUEST.attach, { seq: 3, sessionId: id }));
socket.write(encodeByteFrame(REQUEST.write, id, new TextEncoder().encode("printf 'su%s\\n' 'rvive-me'\r")));
const output = () => seen.filter((f) => f.kind === RESPONSE.data).map((f) => new TextDecoder().decode(f.bytes)).join('');
await wait(() => output().includes('survive-me'), 'pty output over a real socket');
console.log('ok — pty output crossed a real unix socket');

// THE test: drop the client entirely.
socket.destroy();
await new Promise((r) => setTimeout(r, 1200));
const daemonAlive = spawnSync('ps', ['-p', String(daemonPid)]).status === 0;
const ptyAlive = spawnSync('ps', ['-p', String(ptyPid)]).status === 0;
console.log('ok — daemon alive after client left:', daemonAlive);
console.log('ok — pty alive after client left:', ptyAlive);

// And a NEW client reattaches and gets the screen it missed.
const s2 = connect(sock);
const d2 = new FrameDecoder(); const seen2 = [];
s2.on('data', (c) => { seen2.push(...d2.feed(new Uint8Array(c)).frames); });
await new Promise((r) => s2.once('connect', r));
s2.write(encodeJsonFrame(REQUEST.hello, { seq: 1, version: PROTOCOL_VERSION }));
s2.write(encodeJsonFrame(REQUEST.attach, { seq: 2, sessionId: id }));
const out2 = () => seen2.filter((f) => f.kind === RESPONSE.data).map((f) => new TextDecoder().decode(f.bytes)).join('');
await wait(() => out2().includes('survive-me'), 'the reattaching client to be handed the screen');
console.log('ok — a NEW client reattached and was handed the screen it missed');
s2.destroy();
spawnSync('kill', [String(daemonPid)]);
console.log(daemonAlive && ptyAlive ? '\nVERDICT: the daemon survives its client, and a new client reattaches' : '\nVERDICT: FAILED');
