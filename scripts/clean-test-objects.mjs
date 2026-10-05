import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '../packages/core/node_modules/@aws-sdk/client-s3/dist-cjs/index.js';

const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9002',
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
  },
});
const bucket = process.env.S3_BUCKET ?? 'bop';
let deleted = 0;
for (const prefix of ['test/', 'smoke/', 'e2e/']) {
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key }));
    if (keys.length > 0) {
      await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
      deleted += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}
console.log(`deleted ${deleted} test objects from ${bucket}`);
client.destroy();
