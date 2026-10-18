-- Additive and nullable. Records which Meta app issued the token held on a sign-up attempt, so the commit can refuse
-- to attach it to a different app if the configuration changed in between. Existing attempts keep NULL.
-- AlterTable
ALTER TABLE "WhatsappSignupAttempt" ADD COLUMN     "signupAppId" TEXT;
