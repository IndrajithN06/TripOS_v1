-- AlterTable
ALTER TABLE "QuoteSendAttempt" ADD COLUMN     "templateId" UUID;

-- AlterTable
ALTER TABLE "QuoteVersion" ADD COLUMN     "publicToken" TEXT;

-- AlterTable
ALTER TABLE "WhatsappTemplate" ADD COLUMN     "headerMediaAssetId" UUID,
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'custom',
ADD COLUMN     "spec" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "QuoteVersion_publicToken_key" ON "QuoteVersion"("publicToken");

