import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { AppConfigDto } from '@bop/contracts';
import { DomainError, type Core } from '@bop/core';
import type { Request, Response } from 'express';
import { CORE, principal, type AuthedRequest } from '../common/http';
import { buildOpenApi } from '../openapi';

const echoLog: Array<{ at: string; headers: Record<string, unknown>; body: unknown }> = [];

const DOCS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Business Ops API</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#111}h1{font-size:22px}table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top}code{font-size:12px}.m{font-weight:700;width:60px}
.GET{color:#2563eb}.POST{color:#059669}.PATCH,.PUT{color:#d97706}.DELETE{color:#dc2626}details pre{background:#f9fafb;padding:8px;overflow:auto;max-height:320px}</style></head>
<body><h1>Business Operations Platform API</h1><p>Machine-readable spec: <a href="/openapi.json">/openapi.json</a> (OpenAPI 3.1). Errors are application/problem+json.</p>
<table id="t"><thead><tr><th>Method</th><th>Path</th><th>Summary</th><th>Scope</th><th>Body</th></tr></thead><tbody></tbody></table>
<script>fetch('/openapi.json').then(r=>r.json()).then(doc=>{const tb=document.querySelector('#t tbody');
for(const [path,ops] of Object.entries(doc.paths))for(const [m,op] of Object.entries(ops)){const tr=document.createElement('tr');
const body=op.requestBody?'<details><summary>schema</summary><pre></pre></details>':'';
tr.innerHTML='<td class="m '+m.toUpperCase()+'">'+m.toUpperCase()+'</td><td><code></code></td><td></td><td></td><td>'+body+'</td>';
tr.children[1].firstChild.textContent=path;tr.children[2].textContent=op.summary||'';tr.children[3].textContent=op['x-required-scope']||(op.security?'auth':'public');
if(op.requestBody)tr.querySelector('pre').textContent=JSON.stringify(op.requestBody.content['application/json'].schema,null,2);tb.appendChild(tr);}});</script></body></html>`;

@Controller()
export class SystemController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('/health')
  async health(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, string> = {};
    try {
      await this.core.deps.db.system.tenant.count();
      checks['postgres'] = 'ok';
    } catch {
      checks['postgres'] = 'down';
    }
    try {
      await this.core.deps.redis.ping();
      checks['redis'] = 'ok';
    } catch {
      checks['redis'] = 'down';
    }
    checks['realtime'] = this.core.deps.realtime.enabled ? 'configured' : 'disabled';
    const ok = checks['postgres'] === 'ok' && checks['redis'] === 'ok';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', checks };
  }

  @Get('/metrics')
  async metrics(@Res() res: Response): Promise<void> {
    res.setHeader('content-type', this.core.deps.metrics.registry.contentType);
    res.end(await this.core.deps.metrics.registry.metrics());
  }

  @Get('/v1/app-config')
  appConfig(): AppConfigDto {
    const { scriptUrl, agentUrl, consoleUrl } = this.core.config.operatorEmbed;
    return { operator: scriptUrl === null ? null : { scriptUrl, agentUrl, consoleUrl } };
  }

  @Get('/openapi.json')
  openapi() {
    return buildOpenApi(this.core.config.publicApiUrl);
  }

  @Get('/docs')
  docs(@Res() res: Response): void {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(DOCS_HTML);
  }

  @Post('/dev/echo')
  @HttpCode(200)
  echo(@Req() req: Request, @Body() body: unknown) {
    if (process.env['NODE_ENV'] === 'production' && process.env['ENABLE_DEV_ECHO'] !== '1')
      throw new DomainError(404, 'not_found', 'Not found');
    echoLog.push({
      at: new Date().toISOString(),
      headers: {
        'idempotency-key': req.header('idempotency-key') ?? null,
        'content-type': req.header('content-type') ?? null,
      },
      body,
    });
    if (echoLog.length > 200) echoLog.shift();
    return { ok: true };
  }

  @Get('/dev/echo')
  echoes() {
    return echoLog;
  }

  @Post('/v1/realtime/ticket')
  @HttpCode(200)
  async ticket(@Req() req: AuthedRequest) {
    const p = principal(req);
    const user = (await this.core.directory.usersById([p.userId])).get(p.userId);
    const ticket = await this.core.deps.realtime.ticket({
      id: p.userId,
      name: user?.name ?? p.userId,
      tenantId: p.tenantId,
    });
    if (ticket === null)
      throw new DomainError(503, 'realtime_unavailable', 'Realtime server is not available; poll instead');
    return { ...ticket, tenantId: p.tenantId };
  }

  @Get('/v1/notifications/stream')
  async stream(@Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const p = principal(req);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: ready\ndata: {"userId":"${p.userId}"}\n\n`);
    const sub = this.core.deps.redis.duplicate();
    const channel = `${this.core.config.redisPrefix}:rt:user:${p.userId}`;
    await sub.subscribe(channel);
    sub.on('message', (_ch: string, message: string) => {
      res.write(`event: message\ndata: ${message}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sub.disconnect();
    });
  }
}
