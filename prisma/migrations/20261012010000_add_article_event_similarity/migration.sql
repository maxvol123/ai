ALTER TABLE "Article" ADD COLUMN "eventSimilarity" DOUBLE PRECISION;
ALTER TABLE "Article" ADD CONSTRAINT "Article_eventSimilarity_range"
CHECK ("eventSimilarity" >= 0 AND "eventSimilarity" <= 1);
