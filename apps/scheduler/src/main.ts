import { Core, SchedulerRuntime } from '@bop/core';

const core = new Core({ service: 'scheduler' });
const metricsPort =
  process.env['SCHEDULER_METRICS_PORT'] === undefined ? undefined : Number(process.env['SCHEDULER_METRICS_PORT']);
const runtime = new SchedulerRuntime(core, { id: process.env['SCHEDULER_ID'], metricsPort });
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
