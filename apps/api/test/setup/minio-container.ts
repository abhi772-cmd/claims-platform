// Spins up an ephemeral MinIO instance via testcontainers and creates
// the bucket the StorageModule expects. Returns the credentials +
// endpoint URL the app needs to connect, plus a teardown.
//
// Used by the Slice W real-S3 integration test. MinIO is a drop-in
// replacement for AWS S3's API surface — the same SigV4 presigned PUT
// and HEAD flows work against it without modification, so we exercise
// the production code path end-to-end without standing up a real OVH
// bucket.

import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export interface MinioHandles {
  container: StartedTestContainer;
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  shutdown: () => Promise<void>;
}

const ROOT_USER = 'minioadmin';
const ROOT_PASS = 'minioadmin';
const BUCKET = 'claims-test';
const REGION = 'us-east-1';

export async function startMinio(): Promise<MinioHandles> {
  const container = await new GenericContainer('minio/minio:RELEASE.2024-06-13T22-53-53Z')
    .withCommand(['server', '/data'])
    .withEnvironment({
      MINIO_ROOT_USER: ROOT_USER,
      MINIO_ROOT_PASSWORD: ROOT_PASS,
    })
    .withExposedPorts(9000)
    .withWaitStrategy(
      Wait.forHttp('/minio/health/live', 9000).withStartupTimeout(60_000),
    )
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(9000);
  const endpoint = `http://${host}:${port}`;

  // Create the bucket the app expects. We use root credentials here;
  // the app uses the same creds for SigV4 presigning. Real production
  // deployments would carve a least-privilege key per tenant — that's
  // a Sprint 5 hardening item.
  const client = new S3Client({
    endpoint,
    region: REGION,
    credentials: { accessKeyId: ROOT_USER, secretAccessKey: ROOT_PASS },
    forcePathStyle: true,
  });
  await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  // MinIO occasionally takes a beat to settle bucket metadata after
  // create. Poll HeadBucket up to a few times so we never hand back
  // an endpoint with a "missing" bucket — that would surface as a
  // 404 on the first PUT and make the failure look like a test bug.
  for (let i = 0; i < 5; i += 1) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
      if (i === 4) throw new Error('MinIO bucket not visible after CreateBucket');
    }
  }
  client.destroy();

  return {
    container,
    endpoint,
    bucket: BUCKET,
    region: REGION,
    accessKey: ROOT_USER,
    secretKey: ROOT_PASS,
    shutdown: async () => {
      await container.stop();
    },
  };
}
