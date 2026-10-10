import { Global, Module } from '@nestjs/common';
import { AI, createAi } from './ai/ai';
import { createEmail, EMAIL } from './email/email';
import { createStorage, STORAGE } from './storage/storage';
import { createWhatsApp, WHATSAPP } from './whatsapp/whatsapp';

@Global()
@Module({
  providers: [
    { provide: STORAGE, useFactory: createStorage },
    { provide: WHATSAPP, useFactory: createWhatsApp },
    { provide: AI, useFactory: createAi },
    { provide: EMAIL, useFactory: createEmail },
  ],
  exports: [STORAGE, WHATSAPP, AI, EMAIL],
})
export class ProvidersModule {}
