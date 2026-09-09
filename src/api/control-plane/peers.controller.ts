import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { requireContext } from '../../platform/context/platform-context.js';
import { PeerService } from '../../domain/peer/peer.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';
import type { SignedAgentCard } from '../../domain/peer/agent-card.js';
import { Doc } from '../openapi/api-doc.decorator.js';
import { ApiTags } from '@nestjs/swagger';

const registerBody = z
  .object({
    name: z.string().min(1).max(120),
    binding: z.enum(['local', 'remote']),
    localAgentName: z.string().min(1).optional(),
    localAgentNamespace: z.string().min(1).optional(),
    endpointUrl: z.string().url().optional(),
    publicKey: z.string().min(1).optional(),
    agentCard: z.record(z.string(), z.unknown()).optional(),
    /** §13.5. Default is containment; propagation is the deliberate exception. */
    failureMode: z.enum(['contain', 'propagate']).default('contain'),
    timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
    inboundTrust: z.enum(['self', 'delegated_identity']).default('self'),
  })
  .strict();

/**
 * The peer registry (§13.6).
 *
 * Peers are ORG-scoped rather than namespace-scoped, which is the whole point: §13.3
 * routes cross-namespace invocation over A2A, so a peer that could only name agents in
 * the caller's own namespace would serve no purpose that `subAgents` does not already.
 */
@ApiTags('peers')
@Controller('v1/peers')
export class PeersController {
  constructor(private readonly peers: PeerService) {}

  @Doc({
    summary: 'List A2A peers',
  })
  @Get()
  async list(): Promise<unknown> {
    const ctx = requireContext();
    return { peers: await this.peers.list(ctx.orgId) };
  }

  @Doc({ summary: 'Register an A2A peer' })
  @Post()
  async register(@Body() body: unknown): Promise<unknown> {
    const parsed = registerBody.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed peer registration', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const ctx = requireContext();
    const d = parsed.data;
    return this.peers.register({
      orgId: ctx.orgId,
      namespaceId: ctx.namespaceId,
      name: d.name,
      binding: d.binding,
      ...(d.localAgentName ? { localAgentName: d.localAgentName } : {}),
      ...(d.localAgentNamespace ? { localAgentNamespace: d.localAgentNamespace } : {}),
      ...(d.endpointUrl ? { endpointUrl: d.endpointUrl } : {}),
      ...(d.publicKey ? { publicKey: d.publicKey } : {}),
      ...(d.agentCard ? { agentCard: d.agentCard as unknown as SignedAgentCard } : {}),
      failureMode: d.failureMode,
      timeoutMs: d.timeoutMs,
      inboundTrust: d.inboundTrust,
    });
  }

  /**
   * §13.6 domain assurance. Re-verified on demand rather than trusted from registration:
   * a key can be rotated and a card can be replaced, and "it verified when we registered
   * it" is not a claim about now.
   */
  @Doc({ summary: 'Verify a peer\'s agent card' })
  @Post(':name/verify-card')
  async verifyCard(@Param('name') name: string): Promise<unknown> {
    const ctx = requireContext();
    return this.peers.verifyStoredCard(ctx.orgId, name);
  }

  @Doc({ summary: 'Check a peer\'s health' })
  @Get(':name/health')
  async health(@Param('name') name: string): Promise<unknown> {
    const ctx = requireContext();
    return this.peers.health(ctx.orgId, name);
  }

  @Doc({ summary: 'Retire a peer' })
  @Delete(':name')
  async retire(@Param('name') name: string): Promise<unknown> {
    const ctx = requireContext();
    await this.peers.retire(ctx.orgId, name);
    return {
      retired: name,
      note: 'Disabled, not deleted — peer_tasks and memory provenance still reference it (§15.3).',
    };
  }
}
