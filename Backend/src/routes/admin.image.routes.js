/**
 * ================================================================
 * ADMIN MENU IMAGE UPLOAD ROUTE
 * ================================================================
 * Handle menu item image uploads to cloud storage
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { uploadMenuItemImage, deleteMenuItemImage, generateS3PresignedUrl } = require('../utils/cloudUpload');
const { authMiddleware } = require('../middleware/auth.middleware');
const { roleMiddleware } = require('../middleware/role.middleware');

// Configure multer for memory storage (upload to cloud, not disk)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2 MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPG, PNG, and WEBP are allowed.'));
    }
  },
});

/**
 * @route   POST /api/admin/menu/upload-image
 * @desc    Upload menu item image to cloud storage
 * @access  Private/Admin
 * @body    file (multipart/form-data)
 * @returns { success, url, size, type }
 */
router.post('/upload-image', authMiddleware, roleMiddleware(['ADMIN']), upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No image file provided',
      });
    }

    // Upload to cloud storage
    const result = await uploadMenuItemImage(req.file.buffer, req.file.mimetype, req.file.originalname);

    res.status(200).json({
      success: true,
      url: result.url,
      size: result.size,
      type: result.type,
      message: 'Image uploaded successfully',
    });
  } catch (error) {
    console.error('Image upload error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Image upload failed',
    });
  }
});

/**
 * @route   DELETE /api/admin/menu/delete-image
 * @desc    Delete menu item image from cloud storage
 * @access  Private/Admin
 * @body    { imageUrl }
 * @returns { success }
 */
router.delete('/delete-image', authMiddleware, roleMiddleware(['ADMIN']), async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        error: 'Image URL is required',
      });
    }

    const success = await deleteMenuItemImage(imageUrl);

    if (success) {
      res.status(200).json({
        success: true,
        message: 'Image deleted successfully',
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Failed to delete image',
      });
    }
  } catch (error) {
    console.error('Image deletion error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Image deletion failed',
    });
  }
});

/**
 * @route   GET /api/admin/menu/presigned-url
 * @desc    Get presigned S3 URL for direct browser upload (optional)
 * @access  Private/Admin
 * @query   { mimeType }
 * @returns { uploadURL, url }
 */
router.get('/presigned-url', authMiddleware, roleMiddleware(['ADMIN']), async (req, res) => {
  try {
    const { mimeType } = req.query;

    if (!mimeType) {
      return res.status(400).json({
        success: false,
        error: 'MIME type is required',
      });
    }

    const result = await generateS3PresignedUrl('menu-item', mimeType);

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Presigned URL generation error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to generate presigned URL',
    });
  }
});

module.exports = router;
