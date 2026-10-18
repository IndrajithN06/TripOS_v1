-- Additive and nullable: existing quotes keep NULL (= not deleted), so nothing changes for them.
-- Soft delete only: no row, version, message, file or audit entry is ever removed. Row-level security and the table
-- grants already cover "Quote"; adding columns needs no new policy.
-- Rollback (manual): DROP INDEX "Quote_agencyId_deletedAt_idx"; ALTER TABLE "Quote" DROP COLUMN "deletedAt", DROP COLUMN "deletedByUserId";

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedByUserId" UUID;

-- CreateIndex
CREATE INDEX "Quote_agencyId_deletedAt_idx" ON "Quote"("agencyId", "deletedAt");
