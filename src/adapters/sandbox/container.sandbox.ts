import { Injectable, Logger } from '@nestjs/common';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { CodeRuntime, Sandbox, SandboxRequest, SandboxResult } from '../../domain/ports/sandbox.port.js';
import { newId } from '../../platform/ids.js';
import { harnessArgv, type HarnessEnvelopeOut } from './harness.js';

const run = promisify(execFile);
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Container-per-invocation isolation.
 *
 * §0.4 requires ONE isolation boundary for all agent types, chosen before the first tool
 * executes. `HttpEgressSandbox` bounds what a tool may do but does not isolate the
 * process, which is honest only while every tool is an HTTP call to a first-party service.
 * The moment agent-authored code runs -- the coding-agent consumer -- that is not enough.
 *
 * This is the Phase-1 answer: a container per invocation, with no host mount, no network
 * beyond an explicit allowlist, a read-only root, dropped capabilities, and hard CPU,
 * memory, pid and time limits. A container escape is still a kernel-surface problem, which
 * is why the declared Phase-3 target is a microVM -- and why the seam is
 * `tools.sandbox_profile` rather than a code path, so that upgrade is a registry change.
 *
 * Selected per tool by profile, not globally: a first-party HTTP call does not need a
 * container per invocation, and paying container start-up for one would make the common
 * case slow to protect against a threat it does not have.
 */
@Injectable()
export class ContainerSandbox implements Sandbox {
  readonly id = 'container';
  private readonly log = new Logger(ContainerSandbox.name);
  private readonly runtime = process.env['SANDBOX_RUNTIME'] ?? 'docker';
  private available: boolean | null = null;

  /**
   * One image per interpreter, because the harness needs that interpreter present.
   * `SANDBOX_IMAGE` still overrides both, which is the seam for the purpose-built image
   * that should eventually replace these public ones -- pinned by digest, with only the
   * toolchain a tool is allowed to reach.
   */
  private imageFor(runtime: CodeRuntime): string {
    const override = process.env['SANDBOX_IMAGE'];
    if (override) return override;
    return runtime === 'node'
      ? (process.env['SANDBOX_IMAGE_NODE'] ?? 'node:22-alpine')
      : (process.env['SANDBOX_IMAGE_PYTHON'] ?? 'python:3.12-alpine');
  }

  async execute(request: SandboxRequest): Promise<SandboxResult> {
    const instanceId = newId();

    if (!(await this.runtimeAvailable())) {
      // Refuse rather than silently fall back to in-process execution. A tool that asked
      // for container isolation and quietly did not get it is the worst outcome here --
      // it looks isolated and is not.
      return {
        instanceId,
        ok: false,
        error: {
          message:
            `Container sandbox requested for ${request.toolRef} but "${this.runtime}" is ` +
            `unavailable. Refusing to execute without the isolation the tool declared.`,
          retryable: false,
        },
      };
    }

    // Checked AFTER runtime availability, deliberately. Both are refusals, but the
    // isolation one is the safety-critical invariant: a tool that asked for container
    // isolation and quietly did not get it is the outcome this class exists to prevent,
    // so it is the answer even when the tool is also missing a body.
    if (!request.code) {
      return {
        instanceId,
        ok: false,
        error: {
          message:
            `Tool ${request.toolRef} routes to the container sandbox but declares no code to ` +
            `run. Set tools.code_runtime and tools.code_source, or give it a profile whose ` +
            `sandbox makes an outbound call instead.`,
          retryable: false,
        },
      };
    }

    // Source, arguments and broker-minted headers all travel on stdin. Never argv (world
    // -readable in /proc), never the environment (inherited by every child the tool
    // spawns) -- either would hand a credential to anything else in the container.
    const payload = JSON.stringify({
      source: request.code.source,
      args: request.args,
      headers: request.headers,
      endpoint: request.endpointUrl,
    });

    try {
      const stdout = await this.spawnContainer(
        [
          'run', '--rm', '-i',
          // No network by default. A tool needing egress declares it, and the profile
          // supplies an allowlisted network rather than the host's.
          '--network', process.env['SANDBOX_NETWORK'] ?? 'none',
          '--read-only',
          '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
          '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges',
          '--pids-limit', '128',
          '--memory', process.env['SANDBOX_MEMORY'] ?? '256m',
          '--cpus', process.env['SANDBOX_CPUS'] ?? '1',
          // The process runs as a non-root user inside the container: a root process in a
          // container is one kernel bug from being root on the host.
          '--user', '65534:65534',
          this.imageFor(request.code.runtime),
          ...harnessArgv(request.code.runtime),
        ],
        payload,
        request.timeoutMs,
      );

      return this.fromEnvelope(instanceId, request, stdout);
    } catch (e) {
      const error = e as Error & { killed?: boolean; code?: number };
      this.log.warn(`sandbox ${instanceId} failed for ${request.toolRef}: ${error.message}`);
      return {
        instanceId,
        ok: false,
        error: {
          message: error.killed ? `Exceeded ${request.timeoutMs}ms` : error.message,
          // A timeout may be transient; a non-zero exit is the tool's own answer.
          retryable: Boolean(error.killed),
        },
      };
    }
  }

  /**
   * Turns the harness's result envelope into a SandboxResult.
   *
   * A tool that FAILED is not a sandbox that failed: the container did its job, and the
   * error belongs to the tool. It is reported as non-retryable because re-running the
   * same source over the same arguments in a fresh container reproduces it exactly --
   * unlike a timeout or an unavailable runtime, which are the sandbox's own problems.
   */
  private fromEnvelope(instanceId: string, request: SandboxRequest, stdout: string): SandboxResult {
    let envelope: HarnessEnvelopeOut;
    try {
      envelope = JSON.parse(stdout.trim()) as HarnessEnvelopeOut;
    } catch {
      // The harness always writes an envelope, so unparseable stdout means the process
      // died in a way that bypassed it -- OOM-killed, or the image lacks the interpreter.
      this.log.warn(`sandbox ${instanceId} produced no result envelope for ${request.toolRef}`);
      return {
        instanceId,
        ok: false,
        error: {
          message:
            `Sandbox produced no result envelope. The container may have been killed, or ` +
            `the image may not provide the "${request.code?.runtime ?? 'declared'}" runtime.`,
          retryable: true,
        },
      };
    }

    if (!envelope.ok) {
      return {
        instanceId,
        ok: false,
        error: { message: envelope.error ?? 'tool failed without a message', retryable: false },
      };
    }
    return { instanceId, ok: true, output: envelope.output ?? null };
  }

  /**
   * Runs the container, writing the payload to its stdin.
   *
   * `spawn` rather than `execFile`: credentials must reach the sandbox on stdin, never as
   * argv or environment. argv is world-readable in /proc and the environment is inherited
   * by every child process -- both would leak a broker-minted token to anything else on
   * the host. `execFile` has no stdin option at all (that is `spawnSync`), so the earlier
   * shape here would have silently passed nothing.
   */
  private spawnContainer(args: string[], input: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.runtime, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        const error = new Error(`Exceeded ${timeoutMs}ms`) as Error & { killed: boolean };
        error.killed = true;
        reject(error);
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        // A container that floods stdout must not exhaust the worker's heap.
        if (stdout.length > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8').slice(0, 4_000);
      });

      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `sandbox exited with code ${String(code)}`));
      });

      child.stdin.on('error', () => undefined); // the child may exit before we finish writing
      child.stdin.end(input);
    });
  }

  /** Probed once and cached: shelling out per invocation to ask would double the cost. */
  private async runtimeAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      await run(this.runtime, ['version', '--format', '{{.Server.Version}}'], { timeout: 5_000 });
      this.available = true;
    } catch {
      this.log.warn(`container runtime "${this.runtime}" is not available`);
      this.available = false;
    }
    return this.available;
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};
