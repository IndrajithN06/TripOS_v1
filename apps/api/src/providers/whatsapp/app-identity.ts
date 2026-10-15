/**
 * Which Meta app an account belongs to. TripOS runs two Meta apps:
 *  - `primary`: the existing Cloud API app (WHATSAPP_APP_ID/SECRET/VERIFY_TOKEN), webhooks on /webhooks/whatsapp;
 *  - `signup`:  the Embedded Signup v4 app (WHATSAPP_SIGNUP_*), webhooks on /webhooks/whatsapp/signup.
 * `WhatsappAccount.metaAppId` is NULL for every account created before this existed and for manual connections; NULL means `primary`.
 * An app id we do not recognise maps to `null` (denied on both routes) rather than being guessed.
 */
export type AppKey = 'primary' | 'signup';

export interface ConfiguredApps { primaryAppId?: string; signupAppId?: string }

export function accountAppKey(metaAppId: string | null | undefined, apps: ConfiguredApps): AppKey | null {
  if (!metaAppId) return 'primary';
  // Single-app setups (both ids equal) have only the primary route.
  if (apps.primaryAppId && metaAppId === apps.primaryAppId) return 'primary';
  if (apps.signupAppId && metaAppId === apps.signupAppId && apps.signupAppId !== apps.primaryAppId) return 'signup';
  return null;
}

/** The app id an operation that is specific to an app (e.g. the template-header upload session) must use for this account. */
export function appIdForAccount(metaAppId: string | null | undefined, apps: ConfiguredApps): string | undefined {
  const key = accountAppKey(metaAppId, apps);
  if (key === 'signup') return apps.signupAppId;
  if (key === 'primary') return metaAppId || apps.primaryAppId;
  return undefined;
}
