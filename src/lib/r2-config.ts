import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const BUCKET_NAME = "stage5-transcription-uploads";
const PRESIGNED_URL_EXPIRY = 3600; // 1 hour

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * Generate a presigned URL for uploading a file to R2
 */
export async function generateUploadUrl(
  client: S3Client,
  key: string,
  contentType: string = "audio/webm"
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(client, command, { expiresIn: PRESIGNED_URL_EXPIRY });
}

/**
 * Generate a presigned URL for downloading a file from R2
 */
export async function generateDownloadUrl(
  client: S3Client,
  key: string
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  return getSignedUrl(client, command, { expiresIn: PRESIGNED_URL_EXPIRY });
}

/**
 * Delete a file from R2 (cleanup after processing)
 */
export async function deleteFile(
  bucket: R2Bucket,
  key: string
): Promise<void> {
  await bucket.delete(key);
}

/**
 * Generate a unique file key for R2
 */
export function generateFileKey(deviceId: string, jobId: string, extension: string = "webm"): string {
  return `transcriptions/${deviceId}/${jobId}.${extension}`;
}
