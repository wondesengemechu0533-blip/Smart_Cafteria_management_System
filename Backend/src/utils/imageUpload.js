const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Safe local image upload helper (development).
 *
 * Accepts either:
 *   - a data URL (`data:image/png;base64,...`)  -> validated + written to disk
 *   - an http(s) URL                            -> stored as-is (external image)
 *
 * Validates MIME type, decoded file size, and actual file magic bytes so
 * executable files can never be stored as food images.
 */

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

const ALLOWED_TYPES = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

// Magic byte signatures for allowed formats
const MAGIC = {
  jpg: Buffer.from([0xff, 0xd8, 0xff]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  webp: Buffer.from([0x52, 0x49, 0x46, 0x46]), // RIFF header, verified with WEBP tag below
};

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'menu');

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
  return UPLOAD_DIR;
}

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

function safeFileName(ext) {
  const name = crypto.randomBytes(8).toString('hex');
  return `${Date.now()}-${name}${ext}`;
}

/**
 * Validate a base64 data URL and return the stored public path.
 * Throws Error with a friendly message on invalid input.
 */
function storeDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error('Invalid image data. Expected a data:image/...;base64,... value');
  }

  const mime = match[1].toLowerCase();
  const ext = ALLOWED_TYPES[mime];
  if (!ext) {
    throw new Error('Invalid image type. Allowed types: JPG, JPEG, PNG, WEBP');
  }

  const base64 = match[2];
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch (e) {
    throw new Error('Invalid image data');
  }

  if (buffer.length === 0) {
    throw new Error('Empty image file');
  }
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error('Image too large. Maximum size is 2 MB');
  }

  const detected = detectType(buffer);
  if (!detected) {
    throw new Error('The uploaded file is not a valid image or could not be verified');
  }
  // mime must match magic bytes
  const expectedExt = ALLOWED_TYPES[mime];
  const expectedMagic = { jpg: 'jpg', png: 'png', webp: 'webp' }[detected];
  if (ext !== expectedExt || ALLOWED_TYPES['image/' + expectedMagic] !== ext) {
    throw new Error('The file content does not match the declared image type');
  }

  const dir = ensureUploadDir();
  const filename = safeFileName(ext);
  fs.writeFileSync(path.join(dir, filename), buffer);

  return `/uploads/menu/${filename}`;
}

/**
 * Store a base64 data URL as a profile photo file and return its public path.
 * Same validation rules as menu images but written under uploads/profile/.
 * Throws Error with a friendly message on invalid input.
 */
function storeProfileImage(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error('Invalid image data. Expected a data:image/...;base64,... value');
  }

  const mime = match[1].toLowerCase();
  const ext = ALLOWED_TYPES[mime];
  if (!ext) {
    throw new Error('Invalid image type. Allowed types: JPG, JPEG, PNG, WEBP');
  }

  const base64 = match[2];
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch (e) {
    throw new Error('Invalid image data');
  }

  if (buffer.length === 0) {
    throw new Error('Empty image file');
  }
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error('Image too large. Maximum size is 2 MB');
  }

  const detected = detectType(buffer);
  if (!detected) {
    throw new Error('The uploaded file is not a valid image or could not be verified');
  }
  if (ext !== { jpg: 'jpg', png: 'png', webp: 'webp' }[detected]) {
    throw new Error('The file content does not match the declared image type');
  }

  const dir = path.join(__dirname, '..', '..', 'uploads', 'profile');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filename = safeFileName(ext);
  fs.writeFileSync(path.join(dir, filename), buffer);

  return `/uploads/profile/${filename}`;
}

/**
 * Normalize an image value coming from an admin form.
 *  - "" / null / undefined                    -> null (no image / cleared)
 *  - "data:image/..."                         -> stored file path
 *  - "http://..." / "https://..."             -> stored as-is
 *  - anything else                            -> rejected
 */
function processImageValue(imageValue) {
  if (imageValue === undefined || imageValue === null || imageValue === '') {
    return null;
  }
  const value = String(imageValue).trim();
  if (value.startsWith('data:')) {
    return storeDataUrl(value);
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  throw new Error('Invalid image. Use an uploaded file or a valid http(s) image URL');
}

/**
 * Delete an uploaded image file from disk (best effort).
 * Only removes files living under the uploads directory.
 */
function deleteUploadedImage(imagePath) {
  if (!imagePath || typeof imagePath !== 'string') return;
  if (!imagePath.startsWith('/uploads/')) return;
  const absolute = path.join(__dirname, '..', '..', imagePath);
  try {
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  } catch (e) {
    // best effort - never fail the request because of a stray file
  }
}

module.exports = {
  processImageValue,
  deleteUploadedImage,
  storeDataUrl,
  storeProfileImage,
  MAX_FILE_SIZE,
  ALLOWED_TYPES,
  UPLOAD_DIR,
};
