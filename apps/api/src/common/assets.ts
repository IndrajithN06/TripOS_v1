import { BadRequestException, Inject, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { sha256 } from './crypto';
import { Tx } from '../db/db.service';
import { STORAGE, StorageProvider } from '../providers/storage/storage';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png' };

/** Detects the real type from magic bytes; the client-declared type is never trusted. */
export function sniffImage(buf: Buffer): 'image/jpeg' | 'image/png' | null {
  if (buf.length > 8 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

@Injectable()
export class AssetService {
  constructor(@Inject(STORAGE) readonly storage: StorageProvider) {}

  async storeImage(tx: Tx, agencyId: string, userId: string | null, file: { buffer: Buffer } | undefined, assetType: 'vehicle_image' | 'logo') {
    if (!file?.buffer?.length) throw new BadRequestException({ code: 'file_required', message: 'A file is required' });
    if (file.buffer.length > MAX_IMAGE_BYTES) throw new PayloadTooLargeException({ code: 'file_too_large', message: 'Images must be 5 MB or smaller' });
    const mime = sniffImage(file.buffer);
    if (!mime) throw new BadRequestException({ code: 'unsupported_file', message: 'Only genuine JPEG or PNG images are accepted' });
    return this.storeBuffer(tx, agencyId, userId, file.buffer, mime, assetType);
  }

  async storeBuffer(tx: Tx, agencyId: string, userId: string | null, data: Buffer, mimeType: string, assetType: string) {
    const ext = EXT[mimeType] ?? (mimeType === 'application/pdf' ? 'pdf' : 'bin');
    const storageKey = `agencies/${agencyId}/${assetType}/${randomUUID()}.${ext}`;
    await this.storage.put(storageKey, data, mimeType);
    return tx.asset.create({ data: { agencyId, storageKey, mimeType, size: data.length, checksum: sha256(data), assetType, createdById: userId } });
  }

  /** Loads an asset through the tenant transaction (RLS) so another agency's asset id yields 404. */
  async load(tx: Tx, agencyId: string, assetId: string) {
    const a = await tx.asset.findFirst({ where: { id: assetId, agencyId } });
    if (!a) throw new NotFoundException({ code: 'not_found', message: 'File not found' });
    return a;
  }

  url(a: { storageKey: string }) { return this.storage.signedUrl(a.storageKey); }
}
