import { Global, Module } from '@nestjs/common';
import { createEmail, EMAIL } from './email/email';
import { createStorage, STORAGE } from './storage/storage';
import { createWhatsApp, WHATSAPP } from './whatsapp/whatsapp';

@Global()
@Module({
  providers: [
    { provide: STORAGE, useFactory: createStorage },
    { provide: WHATSAPP, useFactory: createWhatsApp },
    { provide: EMAIL, useFactory: createEmail },
  ],
  exports: [STORAGE, WHATSAPP, EMAIL],
})
export class ProvidersModule {}
