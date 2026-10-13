const express = require('express');

const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getCart,
  addToCart,
  updateCartItem,
  removeFromCart,
  clearCart,
  getCartSummary,
} = require('../controllers/cart.controller');

// ============================================================
//  ALL ROUTES REQUIRE

AUTHENTICATION;
// ============================================================
router.use(protect);

/**
 * @route   GET /api/cart
 * @desc    Get user's cart
 * @access  Private
 *
 * Frontend: cart.js → getCart()
 */
router.get('/', getCart);

/**
 * @route   GET /api/cart/summary

 * @desc    Get cart summary
 * @access  Private
 * 
 * Frontend: checkout.js → Cart summary
 * Body: { items: [...] }
 */
router.post('/summary', getCartSummary);

/**
 * @route   POST /api/cart
 * @desc    Add item to cart
 * @access  Private
 * 
 * Frontend: menu.html → add-to-cart-btn
 * Body: { itemId, quantity, name, 

price, image }
 */
router.post('/', addToCart);

/**
 * @route   PUT /api/cart/:itemId
 * @desc    Update cart item quantity
 * @access  Private
 *
 * Frontend: cart.js → changeQuantity(id, delta)
 * Body: { quantity }
 */
router.put('/:itemId', updateCartItem);

/**
 * @route   DELETE /api/cart/:itemId

 * @desc    Remove item from cart
 * @access  Private
 * 
 * Frontend: cart.js → removeItem(id)
 */
router.delete('/:itemId', removeFromCart);

/**
 * @route   DELETE /api/cart
 * @desc    Clear cart
 * @access  Private
 *
 * Frontend: cart.js → clearCart()
 */
router.delete('/', clearCart);

module.exports = router;
