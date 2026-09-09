import { Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ArtifactService } from '../../domain/artifact/artifact.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';
import { Doc } from '../openapi/api-doc.decorator.js';
import { ApiTags } from '@nestjs/swagger';

const MAX_INLINE_BYTES = 8 * 1024 * 1024;

const writeBody = z.object({
  /** base64 for binary; `text` for anything readable, which most artifacts are. */
  content: z.string().max(MAX_INLINE_BYTES * 2).optional(),
  contentBase64: z.string().max(MAX_INLINE_BYTES * 2).optional(),
  mediaType: z.string().max(120).default('application/octet-stream'),
  threadId: z.string().uuid().nullish(),
  runId: z.string().uuid().nullish(),
  parentArtifactId: z.string().uuid().nullish(),
  retentionPolicy: z.string().max(60).nullish(),
  ttlSeconds: z.number().int().positive().nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine((b) => Boolean(b.content ?? b.contentBase64), {
  message: 'content or contentBase64 is required',
});

@ApiTags('artifacts')
@Controller('v1/artifacts')
export class ArtifactsController {
  constructor(private readonly artifacts: ArtifactService) {}

  @Doc({
    summary: 'Describe the artifact store',
  })
  @Get('store')
  store(): unknown {
    return { adapters: this.artifacts.describe() };
  }

  @Doc({
    summary: 'Write an artifact',
    body: writeBody,
  })
  @Post()
  async write(@Body() body: unknown): Promise<unknown> {
    const parsed = writeBody.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed artifact', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const d = parsed.data;
    const buffer = d.contentBase64
      ? Buffer.from(d.contentBase64, 'base64')
      : Buffer.from(d.content!, 'utf8');

    if (buffer.byteLength > MAX_INLINE_BYTES) {
      throw new PlatformError('admission_rejected', 'Artifact exceeds the inline limit', {
        limitBytes: MAX_INLINE_BYTES,
        gotBytes: buffer.byteLength,
      });
    }

    return this.artifacts.write({
      body: buffer,
      mediaType: d.mediaType,
      threadId: d.threadId ?? null,
      runId: d.runId ?? null,
      parentArtifactId: d.parentArtifactId ?? null,
      retentionPolicy: d.retentionPolicy ?? null,
      ttlSeconds: d.ttlSeconds ?? null,
      metadata: d.metadata,
    });
  }

  @Doc({
    summary: 'List artifacts',
  })
  @Get()
  async list(
    @Query('threadId') threadId?: string,
    @Query('runId') runId?: string,
  ): Promise<unknown> {
    return { artifacts: await this.artifacts.list({ threadId, runId }) };
  }

  @Doc({
    summary: 'Read artifact metadata',
  })
  @Get(':id')
  async get(@Param('id') id: string): Promise<unknown> {
    return this.artifacts.get(id);
  }

  @Doc({
    summary: 'Download artifact content',
  })
  @Get(':id/content')
  async content(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const { stream, mediaType, sizeBytes } = await this.artifacts.stream(id);
    res.writeHead(200, {
      'content-type': mediaType,
      'content-length': String(sizeBytes),
      // Artifacts are immutable once written -- the id addresses this content and no
      // other, so a client may cache it indefinitely.
      'cache-control': 'private, max-age=31536000, immutable',
    });
    stream.pipe(res);
  }

  @Doc({
    summary: 'List an artifact\'s versions',
  })
  @Get(':id/versions')
  async versions(@Param('id') id: string): Promise<unknown> {
    return { versions: await this.artifacts.versions(id) };
  }

  @Doc({
    summary: 'Place a legal hold',
    description:
      'A held artifact cannot be deleted, including by retention (§11.2).',
  })
  @Post(':id/legal-hold')
  async hold(@Param('id') id: string): Promise<unknown> {
    await this.artifacts.setLegalHold(id, true);
    return { legalHold: true };
  }

  @Doc({
    summary: 'Release a legal hold',
  })
  @Delete(':id/legal-hold')
  async release(@Param('id') id: string): Promise<unknown> {
    await this.artifacts.setLegalHold(id, false);
    return { legalHold: false };
  }

  @Doc({
    summary: 'Delete an artifact',
  })
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<unknown> {
    await this.artifacts.remove(id);
    return { deleted: true };
  }
}
