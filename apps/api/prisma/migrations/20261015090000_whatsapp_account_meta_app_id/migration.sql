-- Additive and nullable: existing rows keep NULL, which means "the primary (original Cloud API) Meta app".
-- Only accounts connected through Embedded Signup get a value (the signup app id, which is public).
-- AlterTable
ALTER TABLE "WhatsappAccount" ADD COLUMN     "metaAppId" TEXT;
