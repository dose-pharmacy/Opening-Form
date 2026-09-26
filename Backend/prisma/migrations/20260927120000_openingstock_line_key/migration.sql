-- Opening-stock lines need to be individually addressable.
--
-- Two changes:
--  1. `lineKey` becomes part of the line's identity, so two otherwise identical
--     lines (which is what "Duplicate row" produces) can both exist.
--  2. `position` records where the line belongs in the form, so a duplicate can
--     sit directly below the row it was copied from and keep that position
--     across reloads and on every device.
--
-- Both default to a value that matches the pre-migration rows exactly, so
-- existing data keeps its identity and no rewrite of the existing rows is needed.

-- AlterTable
ALTER TABLE "OpeningStock" ADD COLUMN "lineKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OpeningStock" ADD COLUMN "position" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Replace the business-key uniqueness with one that includes the line key.
DROP INDEX "OpeningStock_migrationId_batchId_locationId_key";
CREATE UNIQUE INDEX "OpeningStock_migrationId_batchId_locationId_lineKey_key" ON "OpeningStock"("migrationId", "batchId", "locationId", "lineKey");

-- Support for reading a migration's lines back in form order.
CREATE INDEX "OpeningStock_migrationId_position_idx" ON "OpeningStock"("migrationId", "position");
