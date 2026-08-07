#!/usr/bin/env node
import { request } from 'node:http';
import { parseArgv } from './argv.ts';

/**
 * The twenty lines around `argv.ts`: find the socket, POST, print.
 *
 * Kept this small on purpose — every decision worth testing is in `parseArgv`,
 * and this half is the part that needs a running app to exercise at all.
 *
 * The socket comes from `SHEPHERD_CONTROL_SOCK`, which the kernel injects into
 * every pane (ADR 0025 — the kernel injects the correlation env, not an
 * extension). So inside Shepherd this needs no configuration, and outside it the
 * failure is a sentence rather than a stack trace.
 */

/**
 * The kernel's invoke route. Note it is NOT `/commands` — that route exists and
 * LISTS the verb table, which is a different question and answers 404 to a POST.
 * Measured by driving this against a running app, which is the only place the
 * difference shows.
 */
const INVOKE_ROUTE = '/invoke';

async function main(): Promise<number> {
  const parsed = parseArgv(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    process.stderr.write(`shepherd: ${parsed.error}\n`);
    return 2;
  }

  const socketPath = process.env.SHEPHERD_CONTROL_SOCK;
  if (socketPath === undefined || socketPath === '') {
    process.stderr.write(
      'shepherd: SHEPHERD_CONTROL_SOCK is not set, so there is no Shepherd to talk to. ' +
        'This command runs inside a Shepherd pane, where the kernel injects it.\n',
    );
    return 3;
  }

  // Always sent, even empty. `s.nothing()` accepts `{}` (it was taught to, for
  // exactly this reason), and a command whose fields are all optional needs the
  // object to exist — so one shape works for both and this client does not have
  // to know any command'''s schema.
  const body = JSON.stringify({ command: parsed.command, args: parsed.args, caller: parsed.caller });
  const answer = await post(socketPath, body).catch((error: unknown) => {
    process.stderr.write(`shepherd: cannot reach Shepherd on ${socketPath} — ${String(error)}\n`);
    return undefined;
  });
  if (answer === undefined) return 4;

  // The kernel's own shape: `{ok:true,value}` or `{ok:false,error}`. Printed as
  // JSON because the reader is as likely to be an agent as a person, and a
  // pretty table is not parseable. A non-zero exit is what a shell branches on.
  const parsedAnswer = JSON.parse(answer) as { ok?: boolean; value?: unknown; error?: { message?: string } };
  if (parsedAnswer.ok === true) {
    process.stdout.write(`${JSON.stringify(parsedAnswer.value, null, 2)}\n`);
    return 0;
  }
  process.stderr.write(`shepherd: ${parsedAnswer.error?.message ?? answer}\n`);
  return 1;
}

function post(socketPath: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path: INVOKE_ROUTE, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

void main().then((code) => {
  process.exitCode = code;
});
