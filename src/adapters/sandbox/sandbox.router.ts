import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Sandbox, SandboxRequest, SandboxResult } from '../../domain/ports/sandbox.port.js';
import { HttpEgressSandbox } from './http-egress.sandbox.js';
import { ContainerSandbox } from './container.sandbox.js';

/**
 * Routes an invocation to the isolation its tool declared (§0.4).
 *
 * §0.4 asks for ONE boundary for all agent types, which is easy to misread as one
 * mechanism. The invariant that matters is that the boundary is chosen by the PLATFORM
 * from a declared profile, never by the tool at call time and never implicitly — so a tool
 * cannot opt itself into weaker isolation, and adding a stronger runtime is a registry
 * change rather than a code change at every call site.
 *
 * An unknown profile is refused, not defaulted. Defaulting would mean a typo in a registry
 * row silently downgrades isolation.
 */
@Injectable()
export class SandboxRouter implements Sandbox {
  readonly id = 'router';
  private readonly log = new Logger(SandboxRouter.name);
  private readonly byProfile: Map<string, Sandbox>;

  constructor(
    private readonly httpEgress: HttpEgressSandbox,
    private readonly container: ContainerSandbox,
  ) {
    this.byProfile = new Map<string, Sandbox>([
      // A first-party HTTP call does not need a container per invocation; paying
      // start-up for one would slow the common case against a threat it does not have.
      ['http-egress', httpEgress],
      ['mcp', httpEgress],
      ['default', httpEgress],
      // Anything running agent-authored code.
      ['container', container],
      ['code', container],
    ]);
  }

  async execute(request: SandboxRequest): Promise<SandboxResult> {
    const sandbox = this.byProfile.get(request.profile);
    if (!sandbox) {
      this.log.error(`tool ${request.toolRef} declares unknown sandbox profile "${request.profile}"`);
      return {
        instanceId: 'unrouted',
        ok: false,
        error: {
          message:
            `Unknown sandbox profile "${request.profile}". Refusing to execute rather than ` +
            `choose an isolation level the tool did not declare.`,
          retryable: false,
        },
      };
    }
    return sandbox.execute(request);
  }
}
