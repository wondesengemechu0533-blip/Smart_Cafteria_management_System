/**
 * ================================================================
 * CLOUD IMAGE UPLOAD UTILITY - AWS S3 / Google Cloud Storage
 * ================================================================
 * Handles secure image uploads to cloud storage for menu items.
 * Supports both AWS S3 and Google Cloud Storage (GCS).
 * Falls back to local storage if cloud credentials are not configured.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Max file size: 2 MB
const MAX_FILE_SIZE = 2 * 1024 * 1024;

// Allowed image types
const ALLOWED_TYPES = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

// Magic byte signatures
const MAGIC = {
  jpg: Buffer.from([0xff, 0xd8, 0xff]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  webp: Buffer.from([0x52, 0x49, 0x46, 0x46]),
};

/**
 * AWS SDK is an optional dependency, loaded lazily.
 *
 * This module is imported at startup by the admin image routes AND by the
 * delivery-issue photo upload, but S3 is not a dependency of the application
 * itself: without S3 credentials every upload already falls back to local
 * storage. A top-level `require('aws-sdk')` would therefore crash the whole
 * server in any install where the optional package is absent, taking the
 * delivery routes down with it. Resolving it on first real use keeps local
 * storage working and turns a missing S3 setup into a normal fallback.
 */
let AWS = null;
let s3 = null;

function getS3() {
  if (s3) return s3;
  if (!AWS) {
    try {
      // eslint-disable-next-line global-require
      AWS = require('aws-sdk');
    } catch (err) {
      return null;
    }
  }
  s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1',
  });
  return s3;
}

/**
 * Validate image file
 * @param {Buffer} buffer - File buffer
 * @param {String} mimeType - MIME type
 * @returns {Boolean} - True if valid
 */
function validateImage(buffer, mimeType) {
  // Check size
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error('Image too large. Maximum size is 2 MB');
  }

  if (buffer.length === 0) {
    throw new Error('Empty image file');
  }

  // Validate MIME type
  if (!ALLOWED_TYPES[mimeType]) {
    throw new Error('Invalid image type. Allowed: JPG, JPEG, PNG, WEBP');
  }

  // Validate magic bytes
  const detected = detectType(buffer);
  if (!detected) {
    throw new Error('The uploaded file is not a valid image');
  }

  return true;
}

/**
 * Detect image type by magic bytes
 * @param {Buffer} buffer - File buffer
 * @returns {String} - Image type or null
 */
function detectType(buffer) {
  if (buffer.length >= 3 && buffer.slice(0, 3).equals(MAGIC.jpg)) return 'jpg';
  if (buffer.length >= 8 && buffer.slice(0, 8).equals(MAGIC.png)) return 'png';
  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).equals(MAGIC.webp) &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/**
 * Generate safe file name
 * @param {String} ext - File extension
 * @returns {String} - Safe file name
 */
function safeFileName(ext) {
  const name = crypto.randomBytes(8).toString('hex');
  return `menu-items/${Date.now()}-${name}${ext}`;
}

/**
 * Upload image to AWS S3
 * @param {Buffer} fileBuffer - File buffer
 * @param {String} mimeType - MIME type
 * @param {String} originalName - Original file name
 * @returns {Promise<String>} - S3 URL
 */
async function uploadToS3(fileBuffer, mimeType, originalName) {
  try {
    // Validate image
    validateImage(fileBuffer, mimeType);

    const ext = ALLOWED_TYPES[mimeType];
    const key = safeFileName(ext);
    const bucket = process.env.AWS_S3_BUCKET || 'smart-cafeteria-menu-items';

    // Upload to S3
    const params = {
      Bucket: bucket,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
      ACL: 'public-read',
      Metadata: {
        'original-filename': originalName,
        'upload-date': new Date().toISOString(),
      },
    };

    const client = getS3();
    if (!client) throw new Error('aws-sdk is not installed, S3 upload is unavailable');
    const result = await client.upload(params).promise();

    // Return S3 URL
    const url = `https://${bucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;

    return {
      success: true,
      url: url,
      key: key,
      size: fileBuffer.length,
      type: mimeType,
    };
  } catch (error) {
    throw new Error(`S3 Upload Error: ${error.message}`);
  }
}

/**
 * Upload image to Google Cloud Storage
 * @param {Buffer} fileBuffer - File buffer
 * @param {String} mimeType - MIME type
 * @param {String} originalName - Original file name
 * @returns {Promise<String>} - GCS URL
 */
async function uploadToGCS(fileBuffer, mimeType, originalName) {
  try {
    const { Storage } = require('@google-cloud/storage');

    // Validate image
    validateImage(fileBuffer, mimeType);

    const ext = ALLOWED_TYPES[mimeType];
    const fileName = safeFileName(ext);
    const bucketName = process.env.GCS_BUCKET_NAME || 'smart-cafeteria-menu-items';

    // Initialize GCS client
    const storage = new Storage({
      projectId: process.env.GCP_PROJECT_ID,
      keyFilename: process.env.GCP_KEY_FILE,
    });

    const bucket = storage.bucket(bucketName);
    const file = bucket.file(fileName);

    // Upload to GCS
    await file.save(fileBuffer, {
      metadata: {
        contentType: mimeType,
      },
    });

    // Make file public
    await file.makePublic();

    // Return GCS URL
    const url = `https://storage.googleapis.com/${bucketName}/${fileName}`;

    return {
      success: true,
      url: url,
      fileName: fileName,
      size: fileBuffer.length,
      type: mimeType,
    };
  } catch (error) {
    throw new Error(`Google Cloud Storage Upload Error: ${error.message}`);
  }
}

/**
 * Upload image file - routes to appropriate cloud service
 * @param {Buffer} fileBuffer - File buffer
 * @param {String} mimeType - MIME type
 * @param {String} originalName - Original file name
 * @returns {Promise<Object>} - Upload result with URL
 */
async function uploadMenuItemImage(fileBuffer, mimeType, originalName) {
  try {
    const provider = process.env.IMAGE_STORAGE_PROVIDER || 'local';

    switch (provider) {
      case 's3':
        if (!process.env.AWS_ACCESS_KEY_ID) {
          throw new Error('AWS S3 credentials not configured');
        }
        return await uploadToS3(fileBuffer, mimeType, originalName);

      case 'gcs':
        if (!process.env.GCP_PROJECT_ID) {
          throw new Error('Google Cloud Storage not configured');
        }
        return await uploadToGCS(fileBuffer, mimeType, originalName);

      case 'local':
      default:
        return uploadToLocal(fileBuffer, mimeType, originalName);
    }
  } catch (error) {
    console.error('Image upload error:', error);
    throw error;
  }
}

/**
 * Upload an image locally (fallback)
 * @param {Buffer} fileBuffer - File buffer
 * @param {String} mimeType - MIME type
 * @param {String} originalName - Original file name
 * @returns {Object} - Upload result with path
 */
function uploadToLocal(fileBuffer, mimeType, originalName) {
  try {
    validateImage(fileBuffer, mimeType);

    const ext = ALLOWED_TYPES[mimeType];
    const fileName = safeFileName(ext);
    const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'menu');

    // Ensure directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = path.join(uploadDir, path.basename(fileName));
    fs.writeFileSync(filePath, fileBuffer);

    // Return relative path for local storage
    const url = `/uploads/menu/${path.basename(fileName)}`;

    return {
      success: true,
      url: url,
      path: filePath,
      size: fileBuffer.length,
      type: mimeType,
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Upload a delivery-issue photo (optional evidence attached to a problem
 * report).
 *
 * Uses exactly the same validation as menu images (magic bytes, MIME whitelist,
 * 2 MB cap) and the same configured provider, so there is no second upload
 * system to keep in sync. Only the local fallback folder differs, so issue
 * photos are not mixed in with menu assets.
 *
 * @param {Buffer} fileBuffer - File buffer
 * @param {String} mimeType - MIME type
 * @param {String} originalName - Original file name
 * @returns {Promise<Object>} - Upload result with URL
 */
async function uploadDeliveryIssuePhoto(fileBuffer, mimeType, originalName) {
  const provider = process.env.IMAGE_STORAGE_PROVIDER || 'local';

  try {
    switch (provider) {
      case 's3': {
        if (!process.env.AWS_ACCESS_KEY_ID) throw new Error('AWS S3 credentials not configured');
        // Reuse the shared S3/GCS uploaders; the returned URL is provider agnostic.
        return await uploadToS3(fileBuffer, mimeType, originalName);
      }
      case 'gcs': {
        if (!process.env.GCP_PROJECT_ID) throw new Error('Google Cloud Storage not configured');
        return await uploadToGCS(fileBuffer, mimeType, originalName);
      }
      case 'local':
      default:
        return uploadToLocalFolder(fileBuffer, mimeType, 'delivery-issues');
    }
  } catch (error) {
    console.error('Delivery issue photo upload error:', error.message);
    throw error;
  }
}

/**
 * Upload a proof-of-delivery photo.
 *
 * Same validation, naming and provider switch as uploadDeliveryIssuePhoto -
 * only the destination folder differs, so proof photos never mix with issue
 * photos and the two can be pruned or audited independently.
 *
 * @param {Buffer} fileBuffer
 * @param {String} mimeType
 * @param {String} originalName
 * @returns {Promise<Object>} - Upload result with URL
 */
async function uploadDeliveryProofPhoto(fileBuffer, mimeType, originalName) {
  const provider = process.env.IMAGE_STORAGE_PROVIDER || 'local';

  try {
    switch (provider) {
      case 's3': {
        if (!process.env.AWS_ACCESS_KEY_ID) throw new Error('AWS S3 credentials not configured');
        return await uploadToS3(fileBuffer, mimeType, originalName);
      }
      case 'gcs': {
        if (!process.env.GCP_PROJECT_ID) throw new Error('Google Cloud Storage not configured');
        return await uploadToGCS(fileBuffer, mimeType, originalName);
      }
      case 'local':
      default:
        return uploadToLocalFolder(fileBuffer, mimeType, 'delivery-proofs');
    }
  } catch (error) {
    console.error('Delivery proof photo upload error:', error.message);
    throw error;
  }
}

/**
 * Local-storage upload into a named sub-folder. Same validation and file-naming
 * rules as uploadToLocal, parameterised by folder.
 */
function uploadToLocalFolder(fileBuffer, mimeType, folder) {
  validateImage(fileBuffer, mimeType);

  const ext = ALLOWED_TYPES[mimeType];
  const fileName = safeFileName(ext);
  const uploadDir = path.join(__dirname, '..', '..', 'uploads', folder);
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const filePath = path.join(uploadDir, path.basename(fileName));
  fs.writeFileSync(filePath, fileBuffer);

  return {
    success: true,
    url: `/uploads/${folder}/${path.basename(fileName)}`,
    path: filePath,
    size: fileBuffer.length,
    type: mimeType,
  };
}

/**
 * Delete image from cloud storage
 * @param {String} imageUrl - Image URL to delete
 * @returns {Promise<Boolean>} - Success status
 */
async function deleteMenuItemImage(imageUrl) {
  try {
    const provider = process.env.IMAGE_STORAGE_PROVIDER || 'local';

    switch (provider) {
      case 's3':
        if (!process.env.AWS_ACCESS_KEY_ID) return true;

        const s3Bucket = process.env.AWS_S3_BUCKET || 'smart-cafeteria-menu-items';
        const s3Key = imageUrl.split(`/${s3Bucket}/`)[1];

        if (s3Key) {
          const client = getS3();
          if (!client) return true;
          await client
            .deleteObject({
              Bucket: s3Bucket,
              Key: s3Key,
            })
            .promise();
        }
        return true;

      case 'gcs':
        if (!process.env.GCP_PROJECT_ID) return true;

        const { Storage } = require('@google-cloud/storage');
        const storage = new Storage();
        const bucketName = process.env.GCS_BUCKET_NAME || 'smart-cafeteria-menu-items';
        const fileName = imageUrl.split(`/${bucketName}/`)[1];

        if (fileName) {
          await storage.bucket(bucketName).file(fileName).delete();
        }
        return true;

      case 'local':
      default:
        // Delete local file if it exists
        const relativePath = imageUrl.replace(/^\/uploads\/menu\//, '');
        const filePath = path.join(__dirname, '..', '..', 'uploads', 'menu', path.basename(relativePath));

        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        return true;
    }
  } catch (error) {
    console.error('Error deleting image:', error);
    return false;
  }
}

/**
 * Generate presigned URL for direct browser upload (S3 only)
 * @param {String} fileName - File name
 * @param {String} mimeType - MIME type
 * @returns {Promise<Object>} - Presigned URL and form data
 */
async function generateS3PresignedUrl(fileName, mimeType) {
  try {
    if (!process.env.AWS_ACCESS_KEY_ID) {
      throw new Error('AWS S3 credentials not configured');
    }

    const ext = ALLOWED_TYPES[mimeType];
    if (!ext) {
      throw new Error('Invalid image type');
    }

    const key = safeFileName(ext);
    const bucket = process.env.AWS_S3_BUCKET || 'smart-cafeteria-menu-items';

    const params = {
      Bucket: bucket,
      Key: key,
      ContentType: mimeType,
      Expires: 3600, // 1 hour
    };

    const client = getS3();
    if (!client) throw new Error('aws-sdk is not installed, presigned uploads are unavailable');
    const uploadURL = await client.getSignedUrlPromise('putObject', params);
    const url = `https://${bucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;

    return {
      uploadURL: uploadURL,
      url: url,
      key: key,
    };
  } catch (error) {
    throw new Error(`Failed to generate presigned URL: ${error.message}`);
  }
}

module.exports = {
  uploadMenuItemImage,
  uploadDeliveryIssuePhoto,
  uploadDeliveryProofPhoto,
  deleteMenuItemImage,
  generateS3PresignedUrl,
  uploadToS3,
  uploadToGCS,
  uploadToLocal,
  uploadToLocalFolder,
  validateImage,
  safeFileName,
};
