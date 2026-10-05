import { RealtimeServer, configFromEnv, defaultAuthorizer, type Authorizer } from '@ashamrai/realtime-server';

export const tenantAuthorizer: Authorizer = (user, action, channel) => {
  if (channel.type !== 'room') return defaultAuthorizer(user, action, channel);
  const tid = user.claims['tid'];
  if (typeof tid !== 'string' || !channel.id.startsWith(`t.${tid}.`)) return false;
  return action !== 'publish';
};

const server = new RealtimeServer({ config: configFromEnv(), authorize: tenantAuthorizer });
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.stop().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await server.start();
server.log.info({ port: server.config.port }, 'bop realtime server (03 engine + tenant ACL) started');
