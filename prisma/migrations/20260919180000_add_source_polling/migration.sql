ALTER TABLE "Source"
  ADD COLUMN "pollIntervalMinutes" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "lastCheckedAt" TIMESTAMP(3),
  ADD COLUMN "lastSuccessAt" TIMESTAMP(3),
  ADD COLUMN "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "Source_name_key" ON "Source"("name");
CREATE INDEX "Source_enabled_nextCheckAt_idx" ON "Source"("enabled", "nextCheckAt");
