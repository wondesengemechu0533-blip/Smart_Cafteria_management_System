const Category = require('../models/Category');
const MenuItem = require('../models/MenuItem');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');
const { logAction } = require('../utils/audit');

function toId(name) {
  const base = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'category-' + Date.now();
}

function localName(name, lang) {
  return (name && typeof name === 'object') ? (name[lang] || name.en || '') : String(name || '');
}

function localDesc(description, lang) {
  return (description && typeof description === 'object') ? (description[lang] || description.en || '') : String(description || '');
}

/**
 * @desc    Get all categories (admin) with pagination
 * @route   GET /api/v1/admin/categories
 * @access  Private/Admin
 * Query: page, limit, search, status
 */
exports.getAllCategories = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const filter = {};
    const { search, status } = req.query;
    if (search && String(search).trim()) {
      const term = String(search).trim();
      filter.$or = [
        { 'name.en': { $regex: term, $options: 'i' } },
        { 'name.am': { $regex: term, $options: 'i' } },
        { 'description.en': { $regex: term, $options: 'i' } },
        { 'description.am': { $regex: term, $options: 'i' } },
        { id: { $regex: term, $options: 'i' } },
      ];
    }
    if (status !== undefined && status !== '' && status !== 'all') {
      filter.isActive = status === 'true';
    }

    const sortMap = { name: { 'name.en': 1 }, foods: { sortOrder: 1 }, created: { createdAt: 1 }, updated: { updatedAt: -1 } };
    const sort = sortMap[String(req.query.sort || 'created')] || sortMap.created;
    const [categories, total] = await Promise.all([
      Category.find(filter).sort(sort).skip(skip).limit(limit),
      Category.countDocuments(filter),
    ]);

    const items = await Promise.all(
      categories.map(async (cat) => {
        const count = await MenuItem.countDocuments({ category: cat.id });
        return serialize(cat, count);
      })
    );

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: items.length,
      total,
      page,
      pages: Math.max(Math.ceil(total / limit), 1),
      categories: items,
    });
  } catch (error) {
    console.error('❌ Admin Get All Categories Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

function serialize(cat, itemCount) {
  return {
    id: cat.id,
    name: localName(cat.name, 'en'),
    amharicName: localName(cat.name, 'am'),
    icon: cat.icon,
    imageUrl: cat.imageUrl,
    category: cat.id,
    description: localDesc(cat.description, 'en'),
    isActive: cat.isActive,
    itemCount: typeof itemCount === 'number' ? itemCount : 0,
    sortOrder: cat.sortOrder,
    createdAt: cat.createdAt,
    updatedAt: cat.updatedAt,
  };
}

/**
 * @desc    Get single category by ID
 * @route   GET /api/v1/admin/categories/:id
 * @access  Private/Admin
 */
exports.getCategoryById = async (req, res) => {
  try {
    const category = await Category.findOne({ id: req.params.id });
    if (!category) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Category not found' });
    }
    const count = await MenuItem.countDocuments({ category: category.id });
    const foods = await MenuItem.find({ category: category.id }).sort({ createdAt: -1 }).select('name price image stockQuantity availability availabilityStatus isActive isPopular isRecommended');
    res.status(HTTP_STATUS.OK).json({ success: true, category: serialize(category, count), foods });
  } catch (error) {
    console.error('❌ Admin Get Category By ID Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Create category
 * @route   POST /api/v1/admin/categories
 * @access  Private/Admin
 */
exports.createCategory = async (req, res) => {
  try {
    const { name, icon, imageUrl, description, isActive } = req.body || {};
    if (!name) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Category name is required' });
    }

    const cleanName = String(name).trim();
    if (cleanName.length > 100) return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Category name cannot exceed 100 characters' });
    const id = toId(cleanName);
    const existing = await Category.findOne({ $or: [{ id }, { 'name.en': { $regex: `^${cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }] });
    if (existing) {
      return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: 'A category with this name already exists' });
    }

    const category = await Category.create({
      id,
      name: { en: cleanName, am: cleanName },
      icon: icon || '🍽️',
      imageUrl: imageUrl || null,
      description: { en: description || '', am: description || '' },
      isActive: isActive !== undefined ? isActive : true,
      sortOrder: await Category.countDocuments(),
    });

    await logAction({
      req,
      action: 'CATEGORY_CREATED',
      entityType: 'Category',
      entityId: String(category.id || category._id),
      description: `Created category "${cleanName}"`,
    });

    res.status(HTTP_STATUS.CREATED).json({ success: true, category: serialize(category) });
  } catch (error) {
    console.error('❌ Admin Create Category Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Update category
 * @route   PUT /api/v1/admin/categories/:id
 * @access  Private/Admin
 */
exports.updateCategory = async (req, res) => {
  try {
    const { name, icon, imageUrl, description, isActive } = req.body || {};
    const category = await Category.findOne({ id: req.params.id });
    if (!category) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Category not found' });
    }

    if (name !== undefined && String(name).trim() !== '') {
      const cleanName = String(name).trim();
      const duplicate = await Category.findOne({ _id: { $ne: category._id }, 'name.en': { $regex: `^${cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
      if (duplicate) return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: 'A category with this name already exists' });
      category.name = { en: cleanName, am: cleanName };
    }
    if (icon !== undefined) category.icon = icon;
    if (imageUrl !== undefined) category.imageUrl = imageUrl || null;
    if (description !== undefined) {
      category.description = { en: description, am: description };
    }
    if (isActive !== undefined) category.isActive = isActive;

    await category.save();

    await logAction({
      req,
      action: 'CATEGORY_UPDATED',
      entityType: 'Category',
      entityId: String(category.id || category._id),
      description: `Updated category "${localName(category.name, 'en') || category.id}"`,
    });

    res.status(HTTP_STATUS.OK).json({ success: true, category: serialize(category) });
  } catch (error) {
    console.error('❌ Admin Update Category Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Toggle category status
 * @route   PATCH /api/v1/admin/categories/:id/status
 * @access  Private/Admin
 */
exports.toggleCategoryStatus = async (req, res) => {
  try {
    const { isActive } = req.body;
    if (isActive === undefined) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Status is required' });
    }
    const category = await Category.findOneAndUpdate({ id: req.params.id }, { isActive }, { new: true });
    if (!category) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Category not found' });
    }

    await logAction({
      req,
      action: 'CATEGORY_STATUS_CHANGED',
      entityType: 'Category',
      entityId: String(category.id || category._id),
      description: `${isActive ? 'Activated' : 'Deactivated'} category "${localName(category.name, 'en') || category.id}"`,
    });

    res.status(HTTP_STATUS.OK).json({ success: true, category: serialize(category) });
  } catch (error) {
    console.error('❌ Admin Toggle Category Status Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Delete category
 * @route   DELETE /api/v1/admin/categories/:id
 * @access  Private/Admin
 */
exports.deleteCategory = async (req, res) => {
  try {
    const category = await Category.findOne({ id: req.params.id });
    if (!category) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Category not found' });
    }
    const itemCount = await MenuItem.countDocuments({ category: category.id });
    if (itemCount > 0) {
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: `Cannot delete category with ${itemCount} menu items. Remove items first.`,
      });
    }
    await Category.findOneAndDelete({ id: req.params.id });

    await logAction({
      req,
      action: 'CATEGORY_DELETED',
      entityType: 'Category',
      entityId: String(category.id || category._id),
      description: `Deleted category "${localName(category.name, 'en') || category.id}"`,
    });

    res.status(HTTP_STATUS.OK).json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    console.error('❌ Admin Delete Category Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get category statistics
 * @route   GET /api/v1/admin/categories/stats
 * @access  Private/Admin
 */
exports.getCategoryStats = async (req, res) => {
  try {
    const [total, active, inactive, usedCategoryIds] = await Promise.all([
      Category.countDocuments(),
      Category.countDocuments({ isActive: true }),
      Category.countDocuments({ isActive: false }),
      MenuItem.distinct('category'),
    ]);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: { totalCategories: total, active, inactive, withFoods: usedCategoryIds.length, empty: Math.max(total - usedCategoryIds.length, 0) },
    });
  } catch (error) {
    console.error('❌ Admin Get Category Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};
