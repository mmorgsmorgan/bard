import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { randomBytes } from 'crypto';

// ══════════════════════════════════════════════════════
// ── Cloudflare R2 Storage ──
// ══════════════════════════════════════════════════════
// R2 is S3-compatible object storage with zero egress fees.
// Sign up: https://dash.cloudflare.com → R2 → Create Bucket
// Get credentials: R2 → Manage R2 API Tokens → Create API Token

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || '';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || ''; // e.g., https://pub-abc123.r2.dev

// Check if R2 is configured
export const isR2Enabled = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME);

let s3Client = null;

if (isR2Enabled) {
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  console.log(`  ✓ R2 storage enabled (bucket: ${R2_BUCKET_NAME})`);
} else {
  console.log('  ℹ R2 storage disabled (using local disk)');
  console.log('    To enable R2: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME');
}

/**
 * Upload a file to R2
 * @param {Buffer} buffer - File buffer
 * @param {string} filename - Desired filename
 * @param {string} contentType - MIME type
 * @param {string} folder - Folder path (e.g., 'pfp', 'portfolio', 'proof')
 * @returns {Promise<string>} - Public URL of uploaded file
 */
export async function uploadToR2(buffer, filename, contentType, folder = 'uploads') {
  if (!isR2Enabled) {
    throw new Error('R2 storage is not configured');
  }

  const key = `${folder}/${filename}`;

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    },
  });

  await upload.done();

  // Return public URL
  if (R2_PUBLIC_URL) {
    return `${R2_PUBLIC_URL}/${key}`;
  } else {
    // If no custom domain, use R2's default URL format
    return `https://pub-${R2_ACCOUNT_ID}.r2.dev/${key}`;
  }
}

/**
 * Delete a file from R2
 * @param {string} key - File key (e.g., 'pfp/wallet-timestamp.png')
 * @returns {Promise<void>}
 */
export async function deleteFromR2(key) {
  if (!isR2Enabled) {
    throw new Error('R2 storage is not configured');
  }

  const command = new DeleteObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });

  await s3Client.send(command);
}

/**
 * Generate a unique filename
 * @param {string} originalName - Original filename
 * @param {string} wallet - User wallet address
 * @returns {string} - Unique filename
 */
export function generateFilename(originalName, wallet = 'unknown') {
  const timestamp = Date.now();
  const random = randomBytes(4).toString('hex');
  const ext = originalName.split('.').pop();
  const walletPrefix = wallet.toLowerCase().slice(0, 12);
  return `${walletPrefix}-${timestamp}-${random}.${ext}`;
}
