const Category = require('../models/Category');

const DEFAULT_CATEGORIES = [
  ['beverages', 'Beverages', 'መጠጦች', '🥤'],
  ['breakfast', 'Breakfast', 'ቁርስ', '🍳'],
  ['fasting', 'Fasting', 'የፆም ምግቦች', '🥗'],
  ['main-meals', 'Main Meals', 'ዋና ምግቦች', '🍲'],
  ['snacks', 'Snacks', 'መክሰስ', '🍪'],
];

async function ensureDefaultCategories() {
  for (const [id, en, am, icon] of DEFAULT_CATEGORIES) {
    await Category.updateOne(
      { id },
      {
        $setOnInsert: {
          id,
          name: { en, am },
          icon,
          isActive: true,
          sortOrder: DEFAULT_CATEGORIES.findIndex((item) => item[0] === id) + 1,
        },
      },
      { upsert: true }
    );
  }
}

module.exports = { ensureDefaultCategories };
