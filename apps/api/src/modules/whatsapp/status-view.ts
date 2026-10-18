/** What the admin UI may see of a WhatsApp account. Never includes the credential itself, only whether one is stored. */
export function whatsappStatusView(a: any) {
  return {
    connected: a.connectionStatus !== 'disconnected', mode: a.mode, simulated: a.mode === 'simulator', phoneNumberId: a.phoneNumberId, wabaId: a.wabaId, displayName: a.displayName,
    connectionStatus: a.connectionStatus, statusReason: a.statusReason, webhookSubscribed: a.webhookSubscribed, hasCredential: !!a.credentialSecretRef,
    displayPhoneNumber: a.displayPhoneNumber, verifiedName: a.verifiedName, displayNameStatus: a.displayNameStatus, qualityRating: a.qualityRating, messagingLimitTier: a.messagingLimitTier,
    subscribedAt: a.subscribedAt, lastWebhookAt: a.lastWebhookAt, lastCheckedAt: a.lastCheckedAt, lastErrorCode: a.lastErrorCode, lastErrorAt: a.lastErrorAt,
    onboardingMethod: a.onboardingMethod ?? 'manual', coexistence: !!a.isCoexistence,
  };
}
