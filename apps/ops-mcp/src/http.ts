import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { OpsApiClient } from './client';
import { createMcpServer } from './server';

export interface HttpOptions {
  port: number;
  host: string;
  apiUrl: string;
  defaultToken?: string;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startHttp(options: HttpOptions): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/health') return json(res, 200, { status: 'ok', apiUrl: options.apiUrl });
      if (url.pathname !== '/mcp') return json(res, 404, { error: 'not found' });
      if (req.method !== 'POST')
        return json(res, 405, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST' },
          id: null,
        });
      const auth = req.headers.authorization;
      const token =
        auth !== undefined && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : options.defaultToken;
      if (token === undefined || token === '')
        return json(res, 401, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Authorization: Bearer <API token> is required' },
          id: null,
        });
      const body = await readBody(req);
      const mcp = createMcpServer(new OpsApiClient(options.apiUrl, token));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((error: unknown) => {
      if (!res.headersSent)
        json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: (error as Error).message }, id: null });
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  return server;
}
