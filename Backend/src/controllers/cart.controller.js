const MenuItem = require('../models/MenuItem');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');

/**
* @desc    Get user's cart

* @route   GET /api/cart
* @access  Private
*
* Frontend: cart.js → getCart()
* Response: { success, cart: [...], totalItems, totalPrice }
*/
exports.getCart = async (req, res) => {
  try {
    // Cart is stored in frontend localStorage
    // Backend just validates items and returns current cart
    // For now, we return empty cart - frontend manages cart state
    res.status(HTTP_STATUS.OK).json({
      success: true,
      cart: [],
      totalItems: 0,
      totalPrice: 0,
    });
  } catch (error) {
    console.error('❌ Get Cart Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Add item to cart
 * @route   POST /api/cart
 * @access  Private
 *
 * Frontend: menu.html → add-to-cart-btn
 * Expected Body: { itemId, quantity, name, price, image }
 * Response: { success, cart, totalItems, totalPrice }
 */
exports.addToCart = async (req, res) => {
  try {
    const { itemId, quantity = 1, name, price, image, notes } = req.body;

    if (!itemId) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Item ID is required',
      });
    }

    // ✅ Verify item exists and is available
    const menuItem = await MenuItem.findById(itemId);
    if (!menuItem) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Item not found',
      });
    }

    if (!menuItem.availability || !menuItem.isAvailable) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Item is currently unavailable',
      });
    }

    // ✅ Frontend manages cart in

    localStorage;
    // Backend just validates and returns success
    // Frontend will handle adding to localStorage

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `${menuItem.name.en} added to cart`,
      item: {
        id: menuItem._id,
        name: menuItem.name.en,
        price: menuItem.price,
        quantity: parseInt(quantity),
        image: menuItem.image,
        notes: notes || '',
      },
    });
  } catch (error) {
    console.error('❌ Add To Cart Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
* @desc    Update cart item quantity

* @route   PUT /api/cart/:itemId
* @access  Private
*
* Frontend: cart.js → changeQuantity(id, delta)
* Expected Body: { quantity }
* Response: { success, message }
*/
exports.updateCartItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    const { quantity } = req.body;

    if (!quantity || quantity < 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Valid quantity is required',
      });
    }

    // ✅ Verify item exists
    const menuItem = await MenuItem.findById(itemId);
    if (!menuItem) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Item not found',
      });
    }

    // ✅ Frontend handles cart update in localStorage
    // Backend just validates

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Cart updated successfully',
    });
  } catch (error) {
    console.error('❌ Update Cart Item Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,

      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Remove item from cart
 * @route   DELETE /api/cart/:itemId
 * @access  Private
 *
 * Frontend: cart.js → removeItem(id)
 * Response: { success, message }
 */
exports.removeFromCart = async (req, res) => {
  try {
    const { itemId } = req.params;

    // ✅ Verify item exists
    const menuItem = await MenuItem.findById(itemId);
    if (!menuItem) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Item not found',
      });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Item removed from cart',
    });
  } catch (error) {
    console.error('❌ Remove From Cart Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
* @desc    Clear cart

* @route   DELETE /api/cart
* @access  Private
*
* Frontend: cart.js → clearCart()
* Response: { success, message }
*/
exports.clearCart = async (req, res) => {
  try {
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Cart cleared successfully',
    });
  } catch (error) {
    console.error('❌ Clear Cart Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get cart summary (for checkout)
 * @route   GET /api/cart/summary
 * @access  Private
 *
 * Frontend: checkout.js → Cart summary
 * Expected Body: { items: [...] }
 * Response: { subtotal, serviceFee, total }
 */
exports.getCartSummary = async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Cart is empty',
      });
    }

    // ✅ Calculate totals
    let subtotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const menuItem = await MenuItem.findById(item.id);
      if (!menuItem) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({
          success: false,
          error: `Item ${item.name} not found`,
        });
      }

      const quantity = parseInt(item.quantity) || 1;
      const price = menuItem.price;
      const total = price * quantity;
      subtotal += total;

      validatedItems.push({
        id: menuItem._id,
        name: menuItem.name.en,
        price: price,
        quantity: quantity,
        total: total,
        image: menuItem.image,
      });
    }

    const serviceFee = subtotal > 0 ? 20 : 0;
    const total = subtotal + serviceFee;

    res.status(HTTP_STATUS.OK).json({
      success: true,
      summary: {
        items: validatedItems,
        subtotal: subtotal,
        serviceFee: serviceFee,
        total: total,
        itemCount: validatedItems.length,
      },
    });
  } catch (error) {
    console.error('❌ Get Cart Summary Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};
