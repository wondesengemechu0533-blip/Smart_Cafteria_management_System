const MenuItem = require('../models/MenuItem');
const Category = require('../models/Category');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');

/**
 * @desc    Get all menu items
 * @route   GET /api/menu
 * @access  Public
 * Frontend: menu.html -> Load all food items
 * Query Params: category, search, sort, available
 */
exports.getAllMenuItems = async (req, res) => {
  try {
    const { category, search, sort, available, limit = 50, page = 1 } = req.query;

    let filter = {};
    if (category && category !== 'all') {
      filter.category = category;
    }
    if (available !== undefined) {
      filter.availability = available === 'true';
      filter.isAvailable = available === 'true';
    }
    filter.isActive = true;
    if (available === undefined) {
      filter.availabilityStatus = 'AVAILABLE';
      filter.stockQuantity = { $gt: 0 };
    }
    if (search) {
      filter.$or = [
        { 'name.en': { $regex: search, $options: 'i' } },
        { 'name.am': { $regex: search, $options: 'i' } },
        { 'description.en': { $regex: search, $options: 'i' } },
        { 'description.am': { $regex: search, $options: 'i' } }
      ];
    }

    let sortOption = {};
    switch (sort) {
      case 'low-to-high':
        sortOption.price = 1;
        break;
      case 'high-to-low':
        sortOption.price = -1;
        break;
      case 'name':
        sortOption['name.en'] = 1;
        break;
      default:
        sortOption.createdAt = -1;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);

    const items = await MenuItem.find(filter)
      .sort(sortOption)
      .skip(skip)
      .limit(limitNum);
    const total = await MenuItem.countDocuments(filter);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: items.length,
      total,
      items: items.map((item) => ({
        id: item._id,
        name: { en: item.name.en, am: item.name.am },
        category: item.category,
        price: item.price,
        description: { en: item.description.en || '', am: item.description.am || '' },
        icon: item.icon,
        image: item.image,
        preparationTime: item.preparationTime,
        availability: item.availability,
        isAvailable: item.isAvailable
      }))
    });
  } catch (error) {
    console.error('❌ Get All Menu Items Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get single menu item by ID
 * @route   GET /api/menu/:id
 * @access  Public
 */
exports.getMenuItemById = async (req, res) => {
  try {
    const item = await MenuItem.findById(req.params.id);
    if (!item) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Menu item not found' });
    }
    res.status(HTTP_STATUS.OK).json({
      success: true,
      item: {
        id: item._id,
        name: { en: item.name.en, am: item.name.am },
        category: item.category,
        price: item.price,
        description: { en: item.description.en || '', am: item.description.am || '' },
        icon: item.icon,
        image: item.image,
        preparationTime: item.preparationTime,
        availability: item.availability,
        isAvailable: item.isAvailable,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      }
    });
  } catch (error) {
    console.error('❌ Get Menu Item By ID Error:', error);
    if (error.kind === 'ObjectId') {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Menu item not found' });
    }
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get menu items by category
 * @route   GET /api/menu/category/:category
 * @access  Public
 */
exports.getMenuItemsByCategory = async (req, res) => {
  try {
    const { category } = req.params;
    const { limit = 50 } = req.query;
    const items = await MenuItem.find({ category: category, availability: true }).limit(parseInt(limit));
    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: items.length,
      items: items.map((item) => ({
        id: item._id,
        name: item.name,
        price: item.price,
        category: item.category,
        image: item.image,
        description: item.description,
        preparationTime: item.preparationTime
      }))
    });
  } catch (error) {
    console.error('❌ Get Menu Items By Category Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get featured/limited menu items
 * @route   GET /api/menu/featured
 * @access  Public
 */
exports.getFeaturedItems = async (req, res) => {
  try {
    const { limit = 6 } = req.query;
    const items = await MenuItem.find({ availability: true })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));
    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: items.length,
      items: items.map((item) => ({
        id: item._id,
        name: item.name.en,
        category: item.category,
        price: item.price,
        image: item.image,
        description: item.description.en
      }))
    });
  } catch (error) {
    console.error('❌ Get Featured Items Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get related items (similar category)
 * @route   GET /api/menu/:id/related
 * @access  Public
 */
exports.getRelatedItems = async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 4 } = req.query;
    const currentItem = await MenuItem.findById(id);
    if (!currentItem) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Menu item not found' });
    }
    const items = await MenuItem.find({
      _id: { $ne: id },
      category: currentItem.category,
      availability: true
    }).limit(parseInt(limit));
    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: items.length,
      items: items.map((item) => ({
        id: item._id,
        name: item.name.en,
        category: item.category,
        price: item.price,
        image: item.image,
        icon: item.icon
      }))
    });
  } catch (error) {
    console.error('❌ Get Related Items Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Create new menu item (Admin only)
 * @route   POST /api/menu
 * @access  Private/Admin
 * Expected Body: { name, category, price, description, image, preparationTime, available }
 */
exports.createMenuItem = async (req, res) => {
  try {
    const { name, category, price, description, icon, image, preparationTime, available, isAvailable } = req.body;

    if (!name || !category || !price) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Name, category, and price are required' });
    }
    if (!name.en || !name.am) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Both English and Amharic names are required' });
    }
    if (price < 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Price cannot be negative' });
    }

    const item = await MenuItem.create({
      name: { en: name.en.trim(), am: name.am.trim() },
      category,
      price,
      description: { en: description?.en || '', am: description?.am || '' },
      icon: icon || '🍽️',
      image: image || null,
      preparationTime: preparationTime || 10,
      availability: available !== undefined ? available : true,
      isAvailable: isAvailable !== undefined ? isAvailable : true
    });

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      item: {
        id: item._id,
        name: item.name,
        category: item.category,
        price: item.price,
        description: item.description,
        icon: item.icon,
        image: item.image,
        preparationTime: item.preparationTime,
        availability: item.availability,
        isAvailable: item.isAvailable
      }
    });
  } catch (error) {
    console.error('❌ Create Menu Item Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Update menu item (Admin only)
 * @route   PUT /api/menu/:id
 * @access  Private/Admin
 */
exports.updateMenuItem = async (req, res) => {
  try {
    const { name, category, price, description, icon, image, preparationTime, available, isAvailable } = req.body;

    const item = await MenuItem.findById(req.params.id);
    if (!item) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Menu item not found' });
    }

    if (name) {
      item.name = { en: name.en?.trim() || item.name.en, am: name.am?.trim() || item.name.am };
    }
    if (category) item.category = category;
    if (price !== undefined) item.price = price;
    if (description) {
      item.description = { en: description.en || item.description.en, am: description.am || item.description.am };
    }
    if (icon) item.icon = icon;
    if (image !== undefined) item.image = image;
    if (preparationTime) item.preparationTime = preparationTime;
    if (available !== undefined) item.availability = available;
    if (isAvailable !== undefined) item.isAvailable = isAvailable;

    await item.save();

    res.status(HTTP_STATUS.OK).json({
      success: true,
      item: {
        id: item._id,
        name: item.name,
        category: item.category,
        price: item.price,
        description: item.description,
        icon: item.icon,
        image: item.image,
        preparationTime: item.preparationTime,
        availability: item.availability,
        isAvailable: item.isAvailable
      }
    });
  } catch (error) {
    console.error('❌ Update Menu Item Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Delete menu item (Admin only)
 * @route   DELETE /api/menu/:id
 * @access  Private/Admin
 */
exports.deleteMenuItem = async (req, res) => {
  try {
    const item = await MenuItem.findByIdAndDelete(req.params.id);
    if (!item) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Menu item not found' });
    }
    res.status(HTTP_STATUS.OK).json({ success: true, message: 'Menu item deleted successfully' });
  } catch (error) {
    console.error('❌ Delete Menu Item Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Toggle menu item availability (Admin only)
 * @route   PATCH /api/menu/:id/availability
 * @access  Private/Admin
 */
exports.toggleAvailability = async (req, res) => {
  try {
    const { available } = req.body;
    if (available === undefined) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Available status is required' });
    }
    const item = await MenuItem.findByIdAndUpdate(
      req.params.id,
      { availability: available, isAvailable: available },
      { new: true }
    );
    if (!item) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Menu item not found' });
    }
    res.status(HTTP_STATUS.OK).json({
      success: true,
      item: { id: item._id, name: item.name, availability: item.availability, isAvailable: item.isAvailable }
    });
  } catch (error) {
    console.error('❌ Toggle Availability Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get menu statistics (Admin only)
 * @route   GET /api/menu/stats
 * @access  Private/Admin
 */
exports.getMenuStats = async (req, res) => {
  try {
    const totalItems = await MenuItem.countDocuments();
    const availableItems = await MenuItem.countDocuments({ availability: true, isAvailable: true });
    const outOfStockItems = await MenuItem.countDocuments({ $or: [{ availability: false }, { isAvailable: false }] });
    const totalCategories = await Category.countDocuments();

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: { totalItems, availableItems, outOfStockItems, totalCategories }
    });
  } catch (error) {
    console.error('❌ Get Menu Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};
