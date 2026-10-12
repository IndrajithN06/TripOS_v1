-- AlterTable
ALTER TABLE "WhatsappAccount" ADD COLUMN     "displayNameStatus" TEXT,
ADD COLUMN     "displayPhoneNumber" TEXT,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "lastErrorAt" TIMESTAMP(3),
ADD COLUMN     "lastErrorCode" TEXT,
ADD COLUMN     "lastWebhookAt" TIMESTAMP(3),
ADD COLUMN     "messagingLimitTier" TEXT,
ADD COLUMN     "qualityRating" TEXT,
ADD COLUMN     "statusReason" TEXT,
ADD COLUMN     "subscribedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedName" TEXT;

-- AlterTable
ALTER TABLE "WhatsappTemplate" ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedReason" TEXT;

-- CreateIndex
CREATE INDEX "WhatsappAccount_wabaId_idx" ON "WhatsappAccount"("wabaId");
