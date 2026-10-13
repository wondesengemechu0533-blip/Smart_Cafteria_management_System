const Category = require('../models/Category');
const MenuItem = require('../models/MenuItem');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');

/**
 * @desc    Get all categories
 * @route   GET /api/categories
 * @access  Public
 * Frontend: menu.html, admin/categories.html
 */
exports.getAllCategories = async (req, res) => {
  try {
    const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1, createdAt: 1 });

    const categoriesWithCount = await Promise.all(
      categories.map(async (cat) => {
        const count = await MenuItem.countDocuments({ category: cat.id });
        return {
          id: cat.id,
          name: cat.name,
          slug: cat.slug,
          icon: cat.icon,
          imageUrl: cat.imageUrl,
          description: cat.description,
          isActive: cat.isActive,
          itemCount: count,
          sortOrder: cat.sortOrder,
          isFeatured: cat.isFeatured,
          showOnHomepage: cat.showOnHomepage,
          availabilityTime: cat.availabilityTime,
          notes: cat.notes,
        };
      })
    );

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: categoriesWithCount.length,
      categories: categoriesWithCount,
    });
  } catch (error) {
    console.error('❌ Get All Categories Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get single category by ID
 * @route   GET /api/categories/:id
 * @access  Public
 */
exports.getCategoryById = async (req, res) => {
  try {
    const category = await Category.findOne({ id: req.params.id });
    if (!category) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Category not found' });
    }
    if (!category.isActive) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Category not found' });
    }
    const count = await MenuItem.countDocuments({ category: category.id });
    res.status(HTTP_STATUS.OK).json({
      success: true,
      category: {
        id: category.id,
        name: category.name,
        slug: category.slug,
        icon: category.icon,
        imageUrl: category.imageUrl,
        description: category.description,
        isActive: category.isActive,
        itemCount: count,
        sortOrder: category.sortOrder,
        isFeatured: category.isFeatured,
        showOnHomepage: category.showOnHomepage,
        availabilityTime: category.availabilityTime,
        notes: category.notes,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
      },
    });
  } catch (error) {
    console.error('❌ Get Category By ID Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Create new category (Admin only)
 * @route   POST /api/categories
 * @access  Private/Admin
 * Expected Body: { id, name, icon, description, isActive }
 */
exports.createCategory = async (req, res) => {
  try {
    const {
      id,
      name,
      slug,
      icon,
      imageUrl,
      description,
      isActive,
      sortOrder,
      isFeatured,
      showOnHomepage,
      availabilityTime,
      notes,
    } = req.body;
    if (!id || !name) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Category ID and name are required' });
    }

    const existingCategory = await Category.findOne({ id: id.toLowerCase() });
    if (existingCategory) {
      return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: 'Category with this ID already exists' });
    }

    const category = await Category.create({
      id: id.toLowerCase(),
      name: { en: name.en || name, am: name.am || name },
      slug: slug || id.toLowerCase(),
      icon: icon || '🍽️',
      imageUrl: imageUrl || null,
      description: { en: description?.en || '', am: description?.am || '' },
      isActive: isActive !== undefined ? isActive : true,
      sortOrder: sortOrder !== undefined ? sortOrder : await Category.countDocuments(),
      isFeatured: isFeatured === true,
      showOnHomepage: showOnHomepage === true,
      availabilityTime: availabilityTime || { enabled: false, startTime: '', endTime: '' },
      notes: notes || '',
    });

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      category: {
        id: category.id,
        name: category.name,
        slug: category.slug,
        icon: category.icon,
        imageUrl: category.imageUrl,
        description: category.description,
        isActive: category.isActive,
        sortOrder: category.sortOrder,
        isFeatured: category.isFeatured,
        showOnHomepage: category.showOnHomepage,
        availabilityTime: category.availabilityTime,
        notes: category.notes,
      },
    });
  } catch (error) {
    console.error('❌ Create Category Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Update category (Admin only)
 * @route   PUT /api/categories/:id
 * @access  Private/Admin
 * Expected Body: { name, icon, description, isActive }
 */
exports.updateCategory = async (req, res) => {
  try {
    const {
      name,
      slug,
      icon,
      imageUrl,
      description,
      isActive,
      sortOrder,
      isFeatured,
      showOnHomepage,
      availabilityTime,
      notes,
    } = req.body;
    const category = await Category.findOne({ id: req.params.id });
    if (!category) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Category not found' });
    }
    if (name) {
      category.name = { en: name.en || category.name.en, am: name.am || category.name.am };
    }
    if (slug !== undefined) category.slug = slug;
    if (icon) category.icon = icon;
    if (imageUrl !== undefined) category.imageUrl = imageUrl;
    if (description) {
      category.description = {
        en: description.en || category.description.en,
        am: description.am || category.description.am,
      };
    }
    if (isActive !== undefined) category.isActive = isActive;
    if (sortOrder !== undefined) category.sortOrder = sortOrder;
    if (isFeatured !== undefined) category.isFeatured = isFeatured;
    if (showOnHomepage !== undefined) category.showOnHomepage = showOnHomepage;
    if (availabilityTime) category.availabilityTime = availabilityTime;
    if (notes !== undefined) category.notes = notes;

    await category.save();
    res.status(HTTP_STATUS.OK).json({
      success: true,
      category: {
        id: category.id,
        name: category.name,
        slug: category.slug,
        icon: category.icon,
        imageUrl: category.imageUrl,
        description: category.description,
        isActive: category.isActive,
        sortOrder: category.sortOrder,
        isFeatured: category.isFeatured,
        showOnHomepage: category.showOnHomepage,
        availabilityTime: category.availabilityTime,
        notes: category.notes,
      },
    });
  } catch (error) {
    console.error('❌ Update Category Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Delete category (Admin only)
 * @route   DELETE /api/categories/:id
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
    res.status(HTTP_STATUS.OK).json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    console.error('❌ Delete Category Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Toggle category status (Admin only)
 * @route   PATCH /api/categories/:id/status
 * @access  Private/Admin
 * Expected Body: { isActive: true/false }
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
    res.status(HTTP_STATUS.OK).json({
      success: true,
      category: { id: category.id, name: category.name, icon: category.icon, isActive: category.isActive },
    });
  } catch (error) {
    console.error('❌ Toggle Category Status Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};
