import 'dotenv/config';
import { prisma } from './db/prisma';
import { runCollectJob } from './jobs/collect.job';

async function bootstrap(): Promise<void> {
  await runCollectJob();
}

const tickMinutes = Number.parseInt(process.env.COLLECTOR_TICK_MINUTES ?? '5', 10);
const tickMs = (Number.isFinite(tickMinutes) && tickMinutes > 0 ? tickMinutes : 5) * 60_000;

let running = false;

async function tick(): Promise<void> {
  if (running) {
    console.warn('Collection tick skipped because the previous run is still active');
    return;
  }

  running = true;
  try {
    await bootstrap();
  } catch (error) {
    console.error(error);
  } finally {
    running = false;
  }
}

void tick();
const timer = setInterval(() => void tick(), tickMs);

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await prisma.$disconnect();
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
