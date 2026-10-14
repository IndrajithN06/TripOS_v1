-- Additive only: existing WhatsappAccount rows keep working (defaults mark them as manual, non-coexistence connections).

-- AlterTable
ALTER TABLE "WhatsappAccount" ADD COLUMN     "businessId" TEXT,
ADD COLUMN     "connectedByUserId" UUID,
ADD COLUMN     "isCoexistence" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onboardingMethod" TEXT NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "WhatsappSignupAttempt" (
    "id" UUID NOT NULL,
    "agencyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stateHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'started',
    "step" TEXT NOT NULL DEFAULT 'start',
    "codeHash" TEXT,
    "tokenRef" TEXT,
    "wabaId" TEXT,
    "phoneNumberId" TEXT,
    "businessId" TEXT,
    "requestSync" BOOLEAN NOT NULL DEFAULT false,
    "syncStatus" TEXT,
    "failedStep" TEXT,
    "lastErrorCode" TEXT,
    "lastError" TEXT,
    "runStartedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappSignupAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappSignupAttempt_codeHash_key" ON "WhatsappSignupAttempt"("codeHash");

-- CreateIndex
CREATE INDEX "WhatsappSignupAttempt_agencyId_status_idx" ON "WhatsappSignupAttempt"("agencyId", "status");

-- ===== Hand-written section: tenant isolation (same policy as every other tenant table) =====
ALTER TABLE "WhatsappSignupAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WhatsappSignupAttempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WhatsappSignupAttempt"
  USING ("agencyId" = nullif(current_setting('app.agency_id', true), '')::uuid OR current_setting('app.bypass', true) = 'on')
  WITH CHECK ("agencyId" = nullif(current_setting('app.agency_id', true), '')::uuid OR current_setting('app.bypass', true) = 'on');

-- The application role needs the same table privileges as the other tenant tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tripos_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "WhatsappSignupAttempt" TO tripos_app;
  END IF;
END $$;
