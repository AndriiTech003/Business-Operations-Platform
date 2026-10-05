import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import {
  loginSchema,
  memberInviteSchema,
  memberUpdateSchema,
  switchTenantSchema,
  type LoginResponse,
  type MemberDto,
  type TenantSettings,
} from '@bop/contracts';
import { ACCESS_TTL_SEC, REFRESH_TTL_SEC, unauthorized, type Core } from '@bop/core';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CORE, ZBody, parse, principal, type AuthedRequest } from '../common/http';

const COOKIE = 'bop_refresh';
const settingsSchema = z
  .object({
    timezone: z.string().min(1).max(60),
    currency: z.string().length(3),
    invoicePrefix: z
      .string()
      .min(1)
      .max(10)
      .regex(/^[A-Z0-9-]+$/),
    emailsPerMinute: z.number().int().min(1).max(10_000),
    maxConcurrentSteps: z.number().int().min(1).max(200),
  })
  .partial();

@Controller()
export class AuthController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  private setCookie(res: Response, token: string): void {
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.core.config.publicApiUrl.startsWith('https'),
      maxAge: REFRESH_TTL_SEC * 1000,
      path: '/v1/auth',
    });
  }

  @Post('/v1/auth/login')
  @HttpCode(200)
  async login(
    @ZBody(loginSchema) body: z.infer<typeof loginSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const result = await this.core.accounts.login(body.email, body.password, body.tenant);
    this.setCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, expiresIn: ACCESS_TTL_SEC, me: result.me };
  }

  @Post('/v1/auth/refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Body() body: { tenantId?: string } | undefined): Promise<LoginResponse> {
    const token = (req.cookies as Record<string, string> | undefined)?.[COOKIE];
    if (token === undefined) throw unauthorized('No session');
    const result = await this.core.accounts.refresh(
      token,
      typeof body?.tenantId === 'string' ? body.tenantId : undefined,
    );
    return { accessToken: result.accessToken, expiresIn: ACCESS_TTL_SEC, me: result.me };
  }

  @Post('/v1/auth/logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = (req.cookies as Record<string, string> | undefined)?.[COOKIE];
    if (token !== undefined) await this.core.accounts.logout(token);
    res.clearCookie(COOKIE, { path: '/v1/auth' });
  }

  @Post('/v1/auth/switch-tenant')
  @HttpCode(200)
  async switchTenant(
    @Req() req: AuthedRequest,
    @ZBody(switchTenantSchema) body: z.infer<typeof switchTenantSchema>,
  ): Promise<LoginResponse> {
    const p = principal(req);
    const result = await this.core.accounts.issue(p.userId, body.tenantId);
    return { accessToken: result.accessToken, expiresIn: ACCESS_TTL_SEC, me: result.me };
  }

  @Get('/v1/me')
  async me(@Req() req: AuthedRequest) {
    const p = principal(req);
    const me = await this.core.accounts.me(p.userId, p.tenantId);
    return { ...me, scopes: p.scopes, actorType: p.actor.type, tokenId: p.tokenId };
  }

  @Get('/v1/members')
  members(): Promise<MemberDto[]> {
    return this.core.directory.members();
  }

  @Post('/v1/members')
  async addMember(@ZBody(memberInviteSchema) body: z.infer<typeof memberInviteSchema>) {
    return this.core.accounts.addMember(body.email, body.name, body.role);
  }

  @Patch('/v1/members/:userId')
  @HttpCode(204)
  async setRole(
    @Param('userId') userId: string,
    @ZBody(memberUpdateSchema) body: z.infer<typeof memberUpdateSchema>,
  ): Promise<void> {
    await this.core.accounts.setRole(userId, body.role);
  }

  @Delete('/v1/members/:userId')
  @HttpCode(204)
  async removeMember(@Param('userId') userId: string): Promise<void> {
    await this.core.accounts.removeMember(userId);
  }

  @Patch('/v1/settings')
  updateSettings(@Body() body: unknown): Promise<TenantSettings> {
    return this.core.accounts.updateSettings(parse(settingsSchema, body));
  }
}
