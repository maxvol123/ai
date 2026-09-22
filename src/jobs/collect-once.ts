import 'dotenv/config';
import { prisma } from '../db/prisma';
import { runCollectJob } from './collect.job';

runCollectJob()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
