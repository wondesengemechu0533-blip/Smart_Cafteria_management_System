const mongoose = require('mongoose');

const CATEGORY_ALIASES = {
  mains: 'main-meals',
  lunch: 'main-meals',
  dinner: 'main-meals',
  drinks: 'beverages',
};

/**
 * MenuItem Schema - Matches Frontend Requirements
 *
 * Frontend Usage:
 * - menu.html: Display all food items with name, price, image, category
 * - food-details.html: Show detailed view of single item
 * - menu.js (Admin): Add/Edit/Delete menu items
 */
const MenuItemSchema = new mongoose.Schema(
  {
    name: {
      en: {
        type: String,
        required: [true, 'English name is required'],
        trim: true,
      },
      am: {
        type: String,
        required: [true, 'Amharic name is required'],
        trim: true,
      },
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      set: (value) => CATEGORY_ALIASES[String(value || '').toLowerCase()] || String(value || '').toLowerCase(),
    },
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price cannot be negative'],
    },
    description: {
      en: {
        type: String,
        default: '',
      },
      am: {
        type: String,
        default: '',
      },
    },
    icon: {
      type: String,
      default: '🍽️',
    },
    image: {
      type: String,
      default: null,
    },
    preparationTime: {
      type: Number,
      default: 10,
      min: 1,
    },
    isAvailable: {
      type: Boolean,
      default: true,
    },
    isActive: { type: Boolean, default: true },
    stockQuantity: { type: Number, default: 50, min: 0 },
    lowStockThreshold: { type: Number, default: 5, min: 0 },
    availabilityStatus: { type: String, enum: ['AVAILABLE', 'OUT_OF_STOCK', 'UNAVAILABLE'], default: 'AVAILABLE' },
    // Quality hold: set when a quality issue is reported for this item. While
    // true the item must not be flipped back to AVAILABLE automatically or by
    // a plain availability toggle - the quality issue has to be inspected and
    // resolved first (stock alert / issue report workflow).
    qualityHold: { type: Boolean, default: false },
    isPopular: { type: Boolean, default: false },
    isRecommended: { type: Boolean, default: false },
    showOnHomepage: { type: Boolean, default: false },
    availability: {
      type: Boolean,
      default: true,
    },
    outOfStockReason: {
      type: String,
      default: null,
    },
    lastAvailabilityUpdate: {
      type: Date,
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Owning cafeteria (tenant). Stamped server-side on creation.
    cafeteriaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafeteria',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Get menu item with language support
MenuItemSchema.methods.getLocalized = function (lang = 'en') {  return {
    id: this._id,
    name: this.name[lang] || this.name.en,
    category: this.category,
    price: this.price,
    description: this.description[lang] || this.description.en || '',
    icon: this.icon,
    image: this.image,
    preparationTime: this.preparationTime,
    isAvailable: this.isAvailable,
    outOfStockReason: this.outOfStockReason,
  };
};

MenuItemSchema.index({ cafeteriaId: 1, category: 1 });
MenuItemSchema.index({ cafeteriaId: 1, isActive: 1 });

module.exports = mongoose.model('MenuItem', MenuItemSchema);
