import { createApi } from './app';
import { startTracing } from './tracing';

const stopTracing = startTracing('bop-api');
const api = await createApi();
api.core.logger.info({ url: api.url }, 'api listening');
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await api.close();
  if (stopTracing !== null) await stopTracing();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
