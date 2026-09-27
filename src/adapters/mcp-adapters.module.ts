import { Module } from '@nestjs/common';
import { LangChainMcpClient } from './protocol/mcp/langchain.mcp-client.js';
import { MCP_CLIENT } from '../domain/ports/mcp-client.port.js';

/**
 * §2.1: a protocol adapter, never the domain model. The registry decides the transport,
 * never the caller (§18.5).
 */
@Module({
  providers: [LangChainMcpClient, { provide: MCP_CLIENT, useExisting: LangChainMcpClient }],
  exports: [MCP_CLIENT],
})
export class McpAdaptersModule {}
