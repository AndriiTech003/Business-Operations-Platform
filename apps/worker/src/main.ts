import { Core, WorkerRuntime } from '@bop/core';

const core = new Core({ service: 'worker' });
const metricsPort =
  process.env['WORKER_METRICS_PORT'] === undefined ? undefined : Number(process.env['WORKER_METRICS_PORT']);
const runtime = new WorkerRuntime(core, {
  metricsPort,
  relay: process.env['OUTBOX_RELAY'] !== '0',
  mail: process.env['MAIL_DISPATCH'] !== '0',
});
await runtime.start();
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await runtime.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
