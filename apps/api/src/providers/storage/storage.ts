import { Injectable, Logger } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../../config/config';
import { hmacHex, safeEqual } from '../../common/crypto';

export interface StorageProvider {
  readonly name: string;
  put(key: string, data: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Short-lived URL a browser (or WhatsApp provider) can fetch without our session. */
  signedUrl(key: string, ttlSeconds?: number): Promise<string>;
}

export const STORAGE = Symbol('STORAGE');

/** Development adapter: files in a local directory, served through HMAC-signed API URLs. */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly root = path.resolve(config().STORAGE_LOCAL_DIR);

  private resolve(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  }
  get(key: string) { return fs.readFile(this.resolve(key)); }
  async delete(key: string) { await fs.rm(this.resolve(key), { force: true }); }
  async signedUrl(key: string, ttl = config().SIGNED_URL_TTL_SECONDS) {
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const sig = signLocal(key, exp);
    return `${config().API_URL}/media/local?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
  }
}

export const signLocal = (key: string, exp: number) => hmacHex(config().STORAGE_SIGNING_SECRET, `${key}:${exp}`);
export function verifyLocalSignature(key: string, exp: number, sig: string) {
  return Number.isFinite(exp) && exp > Date.now() / 1000 && safeEqual(sig ?? '', signLocal(key, exp));
}

/** Production adapter: any S3-compatible private bucket (AWS S3, Cloudflare R2, MinIO, ...). */
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  private readonly s3: S3Client;
  private readonly bucket = config().STORAGE_BUCKET!;
  constructor() {
    const c = config();
    this.s3 = new S3Client({
      region: c.STORAGE_REGION, endpoint: c.STORAGE_ENDPOINT, forcePathStyle: !!c.STORAGE_ENDPOINT,
      credentials: { accessKeyId: c.STORAGE_ACCESS_KEY_ID!, secretAccessKey: c.STORAGE_SECRET_ACCESS_KEY! },
    });
  }
  async put(key: string, data: Buffer, mimeType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: mimeType }));
  }
  async get(key: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async delete(key: string) { await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
  signedUrl(key: string, ttl = config().SIGNED_URL_TTL_SECONDS) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttl });
  }
}

export function createStorage(): StorageProvider {
  const log = new Logger('Storage');
  const p = config().STORAGE_PROVIDER === 's3' ? new S3StorageProvider() : new LocalStorageProvider();
  log.log(`Storage provider: ${p.name}`);
  return p;
}

@Injectable()
export class _Unused {}
