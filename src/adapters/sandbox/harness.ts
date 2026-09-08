import type { CodeRuntime } from '../../domain/ports/sandbox.port.js';

/**
 * The calling convention between the platform and a function tool's body (§8.1).
 *
 * One JSON envelope in on stdin, one JSON envelope out on stdout. Everything that varies
 * per invocation -- the source, the arguments, the broker-minted headers -- travels that
 * way rather than through argv or the environment: argv is world-readable in /proc and
 * the environment is inherited by every child the tool spawns, so either would leak a
 * credential to anything else running in the container.
 *
 * The harness itself is fixed text in argv, which is safe precisely because it holds no
 * secrets -- it is the same text for every tool of a given runtime.
 */
export interface HarnessEnvelopeIn {
  source: string;
  args: Record<string, unknown>;
  /** Broker-minted, audience-restricted headers (§16.3). Never a raw secret. */
  headers: Record<string, string>;
  endpoint: string | null;
}

export interface HarnessEnvelopeOut {
  ok: boolean;
  output?: unknown;
  error?: string;
}

/**
 * `require` is deliberately NOT blocked.
 *
 * The isolation boundary is the container (§0.4) -- no network unless the profile grants
 * it, a read-only root, dropped capabilities, a non-root user, pid/memory/cpu caps. A
 * JS-level denylist on top of that is security theatre at the wrong layer: it stops a
 * legitimate tool from reading /tmp or spawning a subprocess inside its own sandbox while
 * doing nothing about the threat the container exists to contain. The coding-agent
 * consumer needs exactly those capabilities INSIDE the boundary.
 *
 * A tool that writes to stdout -- a stray `console.log`, a library banner -- must not
 * corrupt the result envelope, so the harness redirects the tool's stdout to stderr and
 * keeps the real stdout for itself. Tool chatter survives as diagnostics.
 */
const NODE_HARNESS = `
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  const write = process.stdout.write.bind(process.stdout);
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (e) {
    write(JSON.stringify({ ok: false, error: 'harness could not parse its input envelope' }));
    return;
  }
  process.stdout.write = process.stderr.write.bind(process.stderr);
  try {
    const mod = { exports: {} };
    const fn = new Function('module', 'exports', 'require', envelope.source);
    fn(mod, mod.exports, require);
    const handler = typeof mod.exports === 'function' ? mod.exports : mod.exports.handler;
    if (typeof handler !== 'function') {
      throw new Error('tool source must export a function: module.exports = async (args, ctx) => ...');
    }
    const output = await handler(envelope.args, { headers: envelope.headers, endpoint: envelope.endpoint });
    write(JSON.stringify({ ok: true, output: output === undefined ? null : output }));
  } catch (e) {
    write(JSON.stringify({ ok: false, error: (e && e.message) ? String(e.message) : String(e) }));
  }
});
`;

const PYTHON_HARNESS = `
import sys, json
raw = sys.stdin.read()
real = sys.stdout
try:
    envelope = json.loads(raw)
except Exception:
    print(json.dumps({"ok": False, "error": "harness could not parse its input envelope"}), file=real)
    sys.exit(0)
sys.stdout = sys.stderr
try:
    scope = {}
    exec(envelope["source"], scope)
    handler = scope.get("handler")
    if not callable(handler):
        raise Exception("tool source must define handler(args, ctx)")
    output = handler(envelope["args"], {"headers": envelope["headers"], "endpoint": envelope["endpoint"]})
    print(json.dumps({"ok": True, "output": output}), file=real)
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}), file=real)
`;

/** The argv that turns a bare interpreter image into the calling convention above. */
export function harnessArgv(runtime: CodeRuntime): string[] {
  return runtime === 'node' ? ['node', '-e', NODE_HARNESS] : ['python3', '-c', PYTHON_HARNESS];
}

export const HARNESS_SOURCE = { node: NODE_HARNESS, python: PYTHON_HARNESS } as const;
