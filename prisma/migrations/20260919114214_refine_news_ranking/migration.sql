/*
  Warnings:

  - You are about to drop the column `authority` on the `Article` table. All the data in the column will be lost.
  - You are about to drop the column `velocity` on the `Article` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Article" DROP COLUMN "authority",
DROP COLUMN "velocity",
ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "eventHint" TEXT,
ADD COLUMN     "expectedAttention" DOUBLE PRECISION,
ADD COLUMN     "sourceAuthority" DOUBLE PRECISION;
