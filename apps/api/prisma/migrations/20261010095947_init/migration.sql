-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'AGENCY_ADMIN', 'SALES');

-- CreateTable
CREATE TABLE "Agency" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'setup_pending',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "plan" TEXT NOT NULL DEFAULT 'standard',
    "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "aiMonthlyLimit" INTEGER NOT NULL DEFAULT 200,
    "salesVisibility" TEXT NOT NULL DEFAULT 'all',
    "taxEnabled" BOOLEAN NOT NULL DEFAULT false,
    "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxMode" TEXT NOT NULL DEFAULT 'exclusive',
    "quoteValidityDays" INTEGER NOT NULL DEFAULT 7,
    "quoteSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "agencyId" UUID,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "role" "Role" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'invited',
    "mfaSecret" TEXT,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "canOverrideRates" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "agencyId" UUID,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyBranding" (
    "agencyId" UUID NOT NULL,
    "logoAssetId" UUID,
    "brandColour" TEXT NOT NULL DEFAULT '#157f58',
    "tagline" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "address" TEXT,
    "footer" TEXT,
    "terms" TEXT,
    "inclusions" TEXT,
    "exclusions" TEXT,

    CONSTRAINT "AgencyBranding_pkey" PRIMARY KEY ("agencyId")
);

-- CreateTable
CREATE TABLE "WhatsappAccount" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'simulator',
    "wabaId" TEXT,
    "phoneNumberId" TEXT NOT NULL,
    "credentialSecretRef" TEXT,
    "displayName" TEXT,
    "connectionStatus" TEXT NOT NULL DEFAULT 'connected',
    "webhookSubscribed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "email" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "status" TEXT NOT NULL DEFAULT 'open',
    "assignedUserId" UUID,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInboundAt" TIMESTAMP(3),
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "summaryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationNote" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "providerMessageId" TEXT,
    "direction" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "text" TEXT,
    "mediaAssetId" UUID,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "sentByUserId" UUID,
    "templateId" UUID,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleType" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "description" TEXT,
    "amenities" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleRate" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "vehicleTypeId" UUID NOT NULL,
    "local8hHours" INTEGER NOT NULL DEFAULT 8,
    "local8hKm" INTEGER NOT NULL DEFAULT 80,
    "local8h80kmPrice" DECIMAL(18,2) NOT NULL,
    "local4hHours" INTEGER NOT NULL DEFAULT 4,
    "local4hKm" INTEGER NOT NULL DEFAULT 40,
    "local4h40kmPrice" DECIMAL(18,2) NOT NULL,
    "extraHourRate" DECIMAL(18,2) NOT NULL,
    "extraKmRate" DECIMAL(18,2) NOT NULL,
    "outstationRatePerKm" DECIMAL(18,2) NOT NULL,
    "minKmPerDay" INTEGER NOT NULL,
    "driverBattaPerDay" DECIMAL(18,2) NOT NULL,
    "defaultToll" DECIMAL(18,2),
    "defaultParking" DECIMAL(18,2),
    "defaultPermit" DECIMAL(18,2),
    "defaultInterstateTax" DECIMAL(18,2),
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleTypeImage" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "vehicleTypeId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "caption" TEXT,
    "altText" TEXT,

    CONSTRAINT "VehicleTypeImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "quoteNumber" TEXT NOT NULL,
    "customerId" UUID NOT NULL,
    "conversationId" UUID,
    "ownerUserId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currentVersionId" UUID,
    "expiryAt" TIMESTAMP(3),
    "followUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteVersion" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "quoteId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "trip" JSONB NOT NULL,
    "vehicleTypeId" UUID NOT NULL,
    "vehicleName" TEXT NOT NULL,
    "rateSnapshot" JSONB NOT NULL,
    "pricingInput" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "discount" DECIMAL(18,2) NOT NULL,
    "tax" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "termsSnapshot" JSONB NOT NULL,
    "pdfAssetId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "QuoteVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteVersionImage" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "quoteVersionId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuoteVersionImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteSendAttempt" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "quoteVersionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "assetId" UUID,
    "messageId" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuoteSendAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappTemplate" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "category" TEXT NOT NULL DEFAULT 'UTILITY',
    "body" TEXT NOT NULL,
    "variableSchema" JSONB NOT NULL DEFAULT '[]',
    "providerTemplateId" TEXT,
    "providerStatus" TEXT NOT NULL DEFAULT 'local_draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "userId" UUID,
    "feature" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "agencyId" UUID,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 4,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SupportAccessGrant" (
    "id" UUID NOT NULL,
    "superAdminId" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agency_slug_key" ON "Agency"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_agencyId_idx" ON "User"("agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_userId_idx" ON "Invitation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappAccount_agencyId_key" ON "WhatsappAccount"("agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappAccount_phoneNumberId_key" ON "WhatsappAccount"("phoneNumberId");

-- CreateIndex
CREATE INDEX "Customer_agencyId_name_idx" ON "Customer"("agencyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_agencyId_phoneE164_key" ON "Customer"("agencyId", "phoneE164");

-- CreateIndex
CREATE INDEX "Conversation_agencyId_lastMessageAt_idx" ON "Conversation"("agencyId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_agencyId_customerId_idx" ON "Conversation"("agencyId", "customerId");

-- CreateIndex
CREATE INDEX "ConversationNote_agencyId_conversationId_idx" ON "ConversationNote"("agencyId", "conversationId");

-- CreateIndex
CREATE INDEX "Message_agencyId_conversationId_createdAt_idx" ON "Message"("agencyId", "conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_agencyId_providerMessageId_key" ON "Message"("agencyId", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_agencyId_idempotencyKey_key" ON "Message"("agencyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_agencyId_eventKey_key" ON "WebhookEvent"("agencyId", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleType_agencyId_name_key" ON "VehicleType"("agencyId", "name");

-- CreateIndex
CREATE INDEX "VehicleRate_agencyId_vehicleTypeId_effectiveAt_idx" ON "VehicleRate"("agencyId", "vehicleTypeId", "effectiveAt");

-- CreateIndex
CREATE INDEX "Asset_agencyId_assetType_idx" ON "Asset"("agencyId", "assetType");

-- CreateIndex
CREATE INDEX "VehicleTypeImage_agencyId_vehicleTypeId_sortOrder_idx" ON "VehicleTypeImage"("agencyId", "vehicleTypeId", "sortOrder");

-- CreateIndex
CREATE INDEX "Quote_agencyId_status_idx" ON "Quote"("agencyId", "status");

-- CreateIndex
CREATE INDEX "Quote_agencyId_createdAt_idx" ON "Quote"("agencyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_agencyId_quoteNumber_key" ON "Quote"("agencyId", "quoteNumber");

-- CreateIndex
CREATE INDEX "QuoteVersion_agencyId_quoteId_idx" ON "QuoteVersion"("agencyId", "quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteVersion_quoteId_versionNumber_key" ON "QuoteVersion"("quoteId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteVersionImage_quoteVersionId_assetId_key" ON "QuoteVersionImage"("quoteVersionId", "assetId");

-- CreateIndex
CREATE INDEX "QuoteSendAttempt_agencyId_quoteVersionId_idx" ON "QuoteSendAttempt"("agencyId", "quoteVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappTemplate_agencyId_name_language_key" ON "WhatsappTemplate"("agencyId", "name", "language");

-- CreateIndex
CREATE INDEX "AiUsage_agencyId_createdAt_idx" ON "AiUsage"("agencyId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_agencyId_createdAt_idx" ON "AuditLog"("agencyId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE INDEX "SupportAccessGrant_superAdminId_agencyId_idx" ON "SupportAccessGrant"("superAdminId", "agencyId");

-- ===== Hand-written section: tenant isolation, money constraints, immutability =====

-- Row-level security. The API sets `app.agency_id` per transaction (tenant context) or
-- `app.bypass = 'on'` for trusted platform/system code (login, webhooks resolution, platform console).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'User','Invitation','AgencyBranding','WhatsappAccount','Customer','Conversation','ConversationNote',
    'Message','WebhookEvent','VehicleType','VehicleRate','Asset','VehicleTypeImage','Quote','QuoteVersion',
    'QuoteVersionImage','QuoteSendAttempt','WhatsappTemplate','AiUsage','AuditLog','Job'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING ("agencyId" = nullif(current_setting('app.agency_id', true), '')::uuid OR current_setting('app.bypass', true) = 'on')
      WITH CHECK ("agencyId" = nullif(current_setting('app.agency_id', true), '')::uuid OR current_setting('app.bypass', true) = 'on')$p$, t);
  END LOOP;
END $$;

ALTER TABLE "Agency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Agency" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Agency"
  USING ("id" = nullif(current_setting('app.agency_id', true), '')::uuid OR current_setting('app.bypass', true) = 'on')
  WITH CHECK ("id" = nullif(current_setting('app.agency_id', true), '')::uuid OR current_setting('app.bypass', true) = 'on');

-- Money can never be negative.
ALTER TABLE "VehicleRate" ADD CONSTRAINT vehicle_rate_non_negative CHECK (
  "local8h80kmPrice" >= 0 AND "local4h40kmPrice" >= 0 AND "extraHourRate" >= 0 AND "extraKmRate" >= 0
  AND "outstationRatePerKm" >= 0 AND "driverBattaPerDay" >= 0 AND "minKmPerDay" >= 0);
ALTER TABLE "QuoteVersion" ADD CONSTRAINT quote_version_non_negative CHECK (
  "subtotal" >= 0 AND "discount" >= 0 AND "tax" >= 0 AND "total" >= 0);

-- A sent quote version is immutable: only its delivery `status` may change afterwards.
CREATE OR REPLACE FUNCTION quote_version_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."sentAt" IS NOT NULL THEN RAISE EXCEPTION 'Sent quote versions cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD."sentAt" IS NOT NULL THEN
    IF NEW."trip" IS DISTINCT FROM OLD."trip" OR NEW."lines" IS DISTINCT FROM OLD."lines"
       OR NEW."total" IS DISTINCT FROM OLD."total" OR NEW."subtotal" IS DISTINCT FROM OLD."subtotal"
       OR NEW."discount" IS DISTINCT FROM OLD."discount" OR NEW."tax" IS DISTINCT FROM OLD."tax"
       OR NEW."rateSnapshot" IS DISTINCT FROM OLD."rateSnapshot" OR NEW."pricingInput" IS DISTINCT FROM OLD."pricingInput"
       OR NEW."termsSnapshot" IS DISTINCT FROM OLD."termsSnapshot" OR NEW."vehicleTypeId" IS DISTINCT FROM OLD."vehicleTypeId"
       OR NEW."pdfAssetId" IS DISTINCT FROM OLD."pdfAssetId" OR NEW."versionNumber" IS DISTINCT FROM OLD."versionNumber"
       OR NEW."sentAt" IS DISTINCT FROM OLD."sentAt" THEN
      RAISE EXCEPTION 'Sent quote versions are immutable (version %)', OLD."versionNumber";
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER quote_version_immutable BEFORE UPDATE OR DELETE ON "QuoteVersion"
  FOR EACH ROW EXECUTE FUNCTION quote_version_immutable();

-- Sent versions' images are frozen too.
CREATE OR REPLACE FUNCTION quote_version_image_frozen() RETURNS trigger AS $$
DECLARE sent timestamp;
BEGIN
  SELECT "sentAt" INTO sent FROM "QuoteVersion" WHERE id = COALESCE(NEW."quoteVersionId", OLD."quoteVersionId");
  IF sent IS NOT NULL THEN RAISE EXCEPTION 'Images of a sent quote version cannot change'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER quote_version_image_frozen BEFORE INSERT OR UPDATE OR DELETE ON "QuoteVersionImage"
  FOR EACH ROW EXECUTE FUNCTION quote_version_image_frozen();

-- Runtime privileges for the non-superuser application role (skipped if the role does not exist yet).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tripos_app') THEN
    GRANT USAGE ON SCHEMA public TO tripos_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tripos_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tripos_app;
    REVOKE DELETE ON "AuditLog" FROM tripos_app;
    REVOKE UPDATE ON "AuditLog" FROM tripos_app;
  END IF;
END $$;
