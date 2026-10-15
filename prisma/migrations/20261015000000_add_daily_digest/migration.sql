ALTER TABLE "Article" ADD COLUMN "channelPublishedAt" TIMESTAMP(3);
CREATE INDEX "Article_status_channelPublishedAt_idx" ON "Article"("status", "channelPublishedAt");

CREATE TABLE "DailyDigest" (
  "date" TEXT NOT NULL PRIMARY KEY,
  "candidates" JSONB NOT NULL,
  "selectedIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reviewMessageIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "version" INTEGER NOT NULL DEFAULT 0,
  "telegramMessageId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
