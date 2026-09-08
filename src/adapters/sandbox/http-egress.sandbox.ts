import { Injectable, Logger } from '@nestjs/common';
import type {
  Sandbox,
  SandboxRequest,
  SandboxResult,
} from '../../domain/ports/sandbox.port.js';
import { newId } from '../../platform/ids.js';
import { buildHttpRequest } from '../../domain/tool-runtime/http-request.js';

/**
 * Phase-1 isolation: an in-process HTTP egress boundary.
 *
 * Honest about what it is. It bounds what a tool can DO (one outbound HTTP call, to a
 * declared endpoint, with a deadline, with broker-minted headers) but it does not isolate
 * the process. That is sufficient while every tool is an HTTP call to a first-party
 * service, and insufficient the moment agent-authored code executes -- see
 * ai-docs/client-interactions/03 for why that consumer forces container or microVM.
 *
 * `tools.sandbox_profile` is the seam: swapping this for a container runtime is a
 * registry change plus one new provider, not a change at any call site.
 */
@Injectable()
export class HttpEgressSandbox implements Sandbox {
  readonly id = 'http-egress';
  private readonly log = new Logger(HttpEgressSandbox.name);

  async execute(request: SandboxRequest): Promise<SandboxResult> {
    const instanceId = newId();
    if (!request.endpointUrl) {
      return {
        instanceId,
        ok: false,
        error: { message: `Tool ${request.toolRef} has no endpoint to call`, retryable: false },
      };
    }

    // The registered shape decides method, path and where arguments go. Falling back to
    // POST-with-args-as-body keeps every tool registered before migration 0016 working.
    let built;
    try {
      built = buildHttpRequest(
        {
          endpointUrl: request.endpointUrl,
          method: request.http?.method ?? 'POST',
          pathTemplate: request.http?.pathTemplate ?? null,
          argPlacement: request.http?.argPlacement ?? (request.http ? null : 'body'),
          staticHeaders: request.http?.staticHeaders ?? {},
        },
        request.args,
      );
    } catch (e) {
      // A malformed template or an argument that tried to escape it is the REGISTRY's or
      // the caller's mistake, not a transient failure. Retrying would repeat it exactly.
      this.log.warn(`tool ${request.toolRef} request could not be built: ${(e as Error).message}`);
      return {
        instanceId,
        ok: false,
        error: { message: (e as Error).message, retryable: false },
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(built.url, {
        method: built.method,
        // Broker-minted headers last: a static header on a registry row must never be
        // able to shadow the credential the broker just issued for this call.
        headers: { ...built.headers, ...request.headers },
        ...(built.body === null ? {} : { body: built.body }),
        // A redirect is a second request to an origin the registry never approved --
        // the classic route to 169.254.169.254. `fetch` follows them by default.
        redirect: 'manual',
        signal: controller.signal,
      });
      // With redirect: 'manual' a 3xx arrives here instead of being followed. Refused
      // rather than chased: the Location could name any origin, and the registry approved
      // exactly one. Reported so a genuine endpoint move is diagnosable rather than silent.
      if (response.status >= 300 && response.status < 400) {
        return {
          instanceId,
          ok: false,
          error: {
            message:
              `Tool endpoint redirected (${response.status}) to ` +
              `"${response.headers.get('location') ?? 'an undisclosed location'}". ` +
              `Redirects are not followed; update the tool's endpoint_url if this is permanent.`,
            retryable: false,
          },
        };
      }

      const text = await response.text();
      const output = safeJson(text);

      if (!response.ok) {
        return {
          instanceId,
          ok: false,
          // 5xx and 429 are worth another attempt; 4xx is the caller's mistake and is not.
          error: {
            message: `Tool endpoint returned ${response.status}`,
            retryable: response.status >= 500 || response.status === 429,
          },
        };
      }
      return { instanceId, ok: true, output };
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      this.log.warn(`tool ${request.toolRef} failed: ${(e as Error).message}`);
      return {
        instanceId,
        ok: false,
        error: {
          message: aborted ? `Tool exceeded ${request.timeoutMs}ms` : (e as Error).message,
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};
