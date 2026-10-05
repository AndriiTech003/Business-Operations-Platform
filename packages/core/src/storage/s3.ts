import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export class ObjectStorage {
  private readonly client: S3Client;
  private bucketReady: Promise<void> | null = null;

  constructor(private readonly options: StorageOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }

  key(path: string): string {
    return `${this.options.prefix}${path}`;
  }

  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
      } catch {
        await this.client.send(new CreateBucketCommand({ Bucket: this.options.bucket })).catch((error: unknown) => {
          const name = (error as { name?: string }).name ?? '';
          if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
        });
      }
    })();
    return this.bucketReady;
  }

  async put(path: string, body: Buffer, contentType: string): Promise<string> {
    await this.ensureBucket();
    const key = this.key(path);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return key;
  }

  async get(key: string): Promise<Buffer | null> {
    await this.ensureBucket();
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      return bytes === undefined ? null : Buffer.from(bytes);
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  close(): void {
    this.client.destroy();
  }
}
