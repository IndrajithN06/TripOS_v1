import { config } from '../../config/config';
import { ConfiguredApps } from './app-identity';

/** The two Meta apps as configured on THIS server. Every caller classifies accounts through this, so the logic cannot drift. */
export function metaApps(): ConfiguredApps {
  const c = config();
  return { primaryAppId: c.WHATSAPP_APP_ID, signupAppId: c.WHATSAPP_SIGNUP_APP_ID };
}
