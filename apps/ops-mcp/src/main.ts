#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OpsApiClient } from './client';
import { startHttp } from './http';
import { createMcpServer } from './server';

const apiUrl = process.env['BOP_API_URL'] ?? 'http://127.0.0.1:4500';
const token = process.env['BOP_API_TOKEN'];

if (process.argv.includes('--http')) {
  const port = Number(process.env['MCP_PORT'] ?? 4530);
  const host = process.env['MCP_HOST'] ?? '127.0.0.1';
  const server = await startHttp({
    port,
    host,
    apiUrl,
    defaultToken: process.env['MCP_ALLOW_DEFAULT_TOKEN'] === '1' ? token : undefined,
  });
  process.stderr.write(`ops-mcp Streamable HTTP on http://${host}:${port}/mcp (API ${apiUrl})\n`);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  if (token === undefined || token === '') {
    process.stderr.write('BOP_API_TOKEN is required (create one in Settings → API tokens)\n');
    process.exit(1);
  }
  const server = createMcpServer(new OpsApiClient(apiUrl, token));
  await server.connect(new StdioServerTransport());
}
