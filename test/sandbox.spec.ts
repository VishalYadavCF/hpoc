import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SandboxRouter } from '../src/adapters/sandbox/sandbox.router.js';
import { HttpEgressSandbox } from '../src/adapters/sandbox/http-egress.sandbox.js';
import { ContainerSandbox } from '../src/adapters/sandbox/container.sandbox.js';
import type { SandboxRequest } from '../src/domain/ports/sandbox.port.js';

const request = (over: Partial<SandboxRequest> = {}): SandboxRequest => ({
  profile: 'http-egress',
  toolRef: 'demo.tool',
  headers: {},
  endpointUrl: null,
  args: {},
  timeoutMs: 5_000,
  ...over,
});

const router = () => new SandboxRouter(new HttpEgressSandbox(), new ContainerSandbox());

describe('sandbox routing (§0.4)', () => {
  it('refuses an unknown profile rather than defaulting', async () => {
    // Defaulting would let a typo in a registry row silently downgrade isolation.
    const result = await router().execute(request({ profile: 'typo-profile' }));
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/Unknown sandbox profile/);
    expect(result.error?.retryable).toBe(false);
  });

  it('sends first-party HTTP tools to the egress boundary, not a container', async () => {
    // A container per invocation for an HTTP call to our own service would slow the
    // common case against a threat it does not have.
    const result = await router().execute(request({ profile: 'http-egress', endpointUrl: null }));
    expect(result.ok).toBe(false);
    // The egress sandbox's own error, proving it was the one that ran.
    expect(result.error?.message).toMatch(/no endpoint to call/);
  });

  it('routes code-bearing profiles to the container sandbox', async () => {
    const result = await router().execute(request({ profile: 'code' }));
    // Either it ran a container or it refused for want of a runtime. What it must never
    // do is silently execute in-process.
    if (!result.ok) {
      expect(result.error?.message).not.toMatch(/no endpoint to call/);
    }
    expect(result.instanceId).toBeTruthy();
  });

  it('refuses to execute when the declared isolation is unavailable', async () => {
    // The worst outcome is a tool that asked for container isolation, quietly did not get
    // it, and ran anyway -- it looks isolated and is not.
    const sandbox = new ContainerSandbox();
    Object.assign(sandbox, { runtime: 'definitely-not-a-real-runtime' });
    const result = await sandbox.execute(request({ profile: 'container' }));
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/Refusing to execute without the isolation/);
  });
});

/**
 * Skipped rather than failed where no container runtime exists: a machine without docker
 * cannot prove anything about container isolation either way, and a red suite there would
 * train people to ignore it. The sandbox's own refusal path is covered above and needs no
 * runtime.
 */
const runtimeAvailable = await promisify(execFile)('docker', ['version', '--format', '{{.Server.Version}}'])
  .then(() => true)
  .catch(() => false);

describe.skipIf(!runtimeAvailable)('container sandbox executes tool logic (§0.4, §8.1)', () => {
  const sandbox = new ContainerSandbox();
  const code = (source: string, over: Partial<SandboxRequest> = {}) =>
    sandbox.execute(
      request({
        profile: 'code',
        toolRef: 'demo.function',
        headers: { authorization: 'Bearer minted-for-this-call' },
        timeoutMs: 30_000,
        code: { runtime: 'node', source },
        ...over,
      }),
    );

  it('runs the tool body and returns what it computed', async () => {
    // The whole point: the entrypoint was `sh -c cat`, which echoed the payload back and
    // executed nothing. A tool that adds its arguments proves code actually ran.
    const result = await code('module.exports = async (args) => ({ sum: args.a + args.b });', {
      args: { a: 2, b: 40 },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ sum: 42 });
  });

  it('keeps a tool’s own stdout out of the result envelope', async () => {
    // A stray console.log would otherwise corrupt the JSON the host parses.
    const result = await code('module.exports = () => { console.log("chatter"); return { ok: 1 }; };');
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ ok: 1 });
  });

  it('hands the tool its broker-minted headers on stdin, never argv', async () => {
    const result = await code('module.exports = (a, ctx) => ({ sawAuth: Boolean(ctx.headers.authorization) });');
    expect(result.output).toEqual({ sawAuth: true });
  });

  it('reports a throwing tool as a tool failure, not a retryable sandbox failure', async () => {
    // Re-running the same source over the same arguments reproduces it exactly, so a
    // retry would only burn the budget.
    const result = await code('module.exports = () => { throw new Error("boom"); };');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('boom');
    expect(result.error?.retryable).toBe(false);
  });

  it('denies egress by default — the isolation is real, not decorative', async () => {
    const result = await code('module.exports = async () => { await fetch("http://example.com"); return "reached"; };');
    expect(result.ok).toBe(false);
    expect(result.output).not.toBe('reached');
  });

  it('refuses a container profile that declares no code, rather than echoing its payload', async () => {
    // This is exactly what `sh -c cat` used to do: return the payload and look successful.
    const result = await sandbox.execute(request({ profile: 'code', args: { a: 1 } }));
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/declares no code to run/);
    expect(result.error?.retryable).toBe(false);
  });
});

describe('http egress sandbox', () => {
  it('refuses a key that escapes its root', async () => {
    const sandbox = new HttpEgressSandbox();
    const result = await sandbox.execute(request({ endpointUrl: 'http://127.0.0.1:1/nope' }));
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
  });
});
