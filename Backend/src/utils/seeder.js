require('dotenv').config();
const mongoose = require('mongoose');
const connectDatabase = require('../config/database');
const User = require('../models/User');
const Category = require('../models/Category');
const MenuItem = require('../models/MenuItem');

const categories = [
  {
    id: 'breakfast',
    name: { en: 'Breakfast', am: 'ቁርስ' },
    icon: '🍳',
    description: { en: 'Start your day with these delicious breakfast options', am: 'ቀንዎን በእነዚህ ጣፋጭ የቁርስ አማራጮች ይጀምሩ' },
    sortOrder: 1,
  },
  {
    id: 'main-meals',
    name: { en: 'Main Meals', am: 'ዋና ምግቦች' },
    icon: '🍲',
    description: { en: 'Hearty traditional and modern main courses', am: 'ልዩ የሀገር ባህል እና ዘመናዊ ዋና ምግቦች' },
    sortOrder: 2,
  },
  {
    id: 'fasting',
    name: { en: 'Fasting', am: 'የፆም ምግቦች' },
    icon: '🥗',
    description: { en: 'Delicious vegetarian and vegan options', am: 'ጣፋጭ የቬጀቴሪያን እና ቪጋን አማራጮች' },
    sortOrder: 3,
  },
  {
    id: 'beverages',
    name: { en: 'Beverages', am: 'መጠጦች' },
    icon: '🥤',
    description: { en: 'Hot and cold drinks', am: 'ትኩስ እና ቀዝቃዛ መጠጦች' },
    sortOrder: 4,
  },
  {
    id: 'snacks',
    name: { en: 'Snacks', am: 'ምቹና የተሰበሰቡ' },
    icon: '🍪',
    description: { en: 'Light bites and quick snacks', am: 'ቀላል እና ፈጣን ምቹና የተሰበሰቡ' },
    sortOrder: 5,
  },
];

const menuItems = [
  // BEVERAGES
  {
    name: { en: 'Fresh Juice', am: 'ትኩስ ጭማቂ' },
    category: 'beverages',
    price: 60,
    description: { en: 'Freshly squeezed seasonal fruit juice', am: 'ትኩስ የበለጠ የፍራፍሬ ጭማቂ' },
    icon: '🧃',
    image: '/assets/images/food/beverages/juice.jpeg',
    preparationTime: 5,
    isAvailable: true,
  },
  {
    name: { en: 'Soft Drink', am: 'ሶፍት ድሪንክ' },
    category: 'beverages',
    price: 40,
    description: { en: 'Chilled carbonated soft drinks', am: 'ቀዝቃዛ የቀረበ ሶፍት ድሪንኮች' },
    icon: '🥤',
    image: '/assets/images/food/beverages/soft-drink.jpeg',
    preparationTime: 2,
    isAvailable: true,
  },
  {
    name: { en: 'Bottled Water', am: 'የቦቱል ውሃ' },
    category: 'beverages',
    price: 20,
    description: { en: 'Pure natural mineral water', am: 'ጥሩ የተገነባ የህይወት ውሃ' },
    icon: '💧',
    image: '/assets/images/food/beverages/water.jpeg',
    preparationTime: 1,
    isAvailable: true,
  },

  // BREAKFAST
  {
    name: { en: 'Firfir', am: 'ፍርፍር' },
    category: 'breakfast',
    price: 90,
    description: { en: 'Shredded injera sautéed with spiced butter and berbere', am: 'በቅቤ እና በርበሬ የተጠበሰ የተፈተፈተ እንጀራ' },
    icon: '🌶️',
    image: '/assets/images/food/breakfast/firfir.jpeg',
    preparationTime: 8,
    isAvailable: true,
  },
  {
    name: { en: 'Omelette (Enkulal Sils)', am: 'ኦሜሌት (እንቁላል ስልስ)' },
    category: 'breakfast',
    price: 85,
    description: {
      en: 'Fluffy omelette with onions, tomatoes, and green peppers',
      am: 'በሽንኩርት፣ ቲማቲም እና ቅይ በርበሬ የተሞላ ኦሜሌት',
    },
    icon: '🍳',
    image: '/assets/images/food/breakfast/omelett(Enkulal sils).jpeg',
    preparationTime: 7,
    isAvailable: true,
  },
  {
    name: { en: 'Pasta with Bread', am: 'ፓስታ ከዳቦ' },
    category: 'breakfast',
    price: 100,
    description: { en: 'Spaghetti with tomato sauce served with fresh bread', am: 'የቲማቲም ጣዋት ከዳቦ ጋር የተቀረበ ስፋጤቲ' },
    icon: '🍝',
    image: '/assets/images/food/breakfast/pasta-with-bread.jpg',
    preparationTime: 10,
    isAvailable: true,
  },
  {
    name: { en: 'Pasta with Injera', am: 'ፓስታ ከእንጀራ' },
    category: 'breakfast',
    price: 100,
    description: {
      en: 'Spaghetti with tomato sauce served with traditional injera',
      am: 'የቲማቲም ጣዋት ከባህላዊ እንጀራ ጋር የተቀረበ ስፋጤቲ',
    },
    icon: '🍝',
    image: '/assets/images/food/breakfast/pasta-with-injera.jpg',
    preparationTime: 10,
    isAvailable: true,
  },
  {
    name: { en: 'Scrambled Eggs', am: 'የተገረፈ እንቁላል' },
    category: 'breakfast',
    price: 75,
    description: {
      en: 'Fluffy scrambled eggs with onions and tomatoes, served with bread',
      am: 'በሽንኩርት እና ቲማቲም የተገረፈ እንቁላል ከዳቦ ጋር',
    },
    icon: '🥚',
    image: '/assets/images/food/breakfast/scrambled-egg.jpeg',
    preparationTime: 5,
    isAvailable: true,
  },

  // FASTING
  {
    name: { en: 'Ful with Bread (Fasting)', am: 'ፉል ከዳቦ (የፆም)' },
    category: 'fasting',
    price: 80,
    description: { en: 'Slow-cooked fava beans with spices, served with bread', am: 'በፍላጎት የተሰበሰበ ባቅላ ከዳቦ ጋር' },
    icon: '🫘',
    image: '/assets/images/food/fasting/ful with Bread (Fasting).jpg',
    preparationTime: 10,
    isAvailable: true,
  },
  {
    name: { en: 'Ful with Bread', am: 'ፉል ከዳቦ' },
    category: 'fasting',
    price: 80,
    description: { en: 'Traditional fava bean stew with spices and bread', am: 'ባህላዊ የባቅላ ጠጅ በርበሬዎች እና ዳቦ ጋር' },
    icon: '🫘',
    image: '/assets/images/food/fasting/ful-with-bread.jpg',
    preparationTime: 10,
    isAvailable: true,
  },
  {
    name: { en: 'Lentil Stew', am: 'ምስር ወጥ' },
    category: 'fasting',
    price: 75,
    description: { en: 'Hearty red lentil stew with berbere and spices', am: 'በበርበሬ እና ሌሎች ሽብር የተጠበቀ ጥሩ የምስር ወጥ' },
    icon: '🍲',
    image: '/assets/images/food/fasting/lentil-stew.jpeg',
    preparationTime: 12,
    isAvailable: true,
  },
  {
    name: { en: 'Mixed Fasting (Yetsom Beyaynet)', am: 'የፆም በያየነት' },
    category: 'fasting',
    price: 120,
    description: {
      en: 'Assorted vegetarian dishes: lentils, split peas, vegetables, and salad',
      am: 'የተለያዩ የፆም ምግቦች፡ ምስር፣ ቅክ፣ አትክልቶች እና ሳላዳ',
    },
    icon: '🥗',
    image: '/assets/images/food/fasting/mixed-fasting(yetsom Beyaynet).jpeg',
    preparationTime: 15,
    isAvailable: true,
  },

  // MAIN MEALS
  {
    name: { en: 'Cabbage with Meat', am: 'ኬብሳ ከስጋ' },
    category: 'main-meals',
    price: 150,
    description: { en: 'Sautéed cabbage with tender beef cubes and spices', am: 'በቅቤ እና በርበሬ የተጠበቀ ኬብሳ ከጣፋጭ ስጋ ጋር' },
    icon: '🥬',
    image: '/assets/images/food/main-meals/cabbage-with-meat.jpeg',
    preparationTime: 15,
    isAvailable: true,
  },
  {
    name: { en: 'Cheese with Butter', am: 'አይብ ከቅቤ' },
    category: 'main-meals',
    price: 130,
    description: { en: 'Traditional Ethiopian cheese sautéed in spiced butter', am: 'በቅቤ የተጠበቀ ባህላዊ የኢትዮጵያ አይብ' },
    icon: '🧀',
    image: '/assets/images/food/main-meals/cheese-with-butter.jpeg',
    preparationTime: 10,
    isAvailable: true,
  },
  {
    name: { en: 'Egg with Meat', am: 'እንቁላል ከስጋ' },
    category: 'main-meals',
    price: 140,
    description: { en: 'Fried eggs topped with seasoned minced meat', am: 'በርበሬ የተጣራ የተለቀለቀ ስጋ የተሳደረ የተፈረሰ እንቁላል' },
    icon: '🍳',
    image: '/assets/images/food/main-meals/egg-with-meat.jpg',
    preparationTime: 10,
    isAvailable: true,
  },
  {
    name: { en: 'Grilled Meat', am: 'የተቀለበ ስጋ' },
    category: 'main-meals',
    price: 180,
    description: { en: 'Charcoal-grilled beef with traditional spices', am: 'ባህላዊ ሽብር በድሮ የተቀለበ የበር ስጋ' },
    icon: '🥩',
    image: '/assets/images/food/main-meals/grilled-meat.jpeg',
    preparationTime: 20,
    isAvailable: true,
  },
  {
    name: { en: 'Pasta with Vegetables', am: 'ፓስታ ከአትክልቶች' },
    category: 'main-meals',
    price: 120,
    description: {
      en: 'Pasta with fresh seasonal vegetables in tomato sauce',
      am: 'በቲማቲም ጣዋት የተጠበቀ ፓስታ ከትኩስ አትክልቶች ጋር',
    },
    icon: '🍝',
    image: '/assets/images/food/main-meals/pasta-with-vegetables.jpeg',
    preparationTime: 12,
    isAvailable: true,
  },
  {
    name: { en: 'Red Stew (Key Wat)', am: 'ቀይ ወጥ' },
    category: 'main-meals',
    price: 160,
    description: { en: 'Spicy beef stew with berbere, served with injera', am: 'በበርበሬ የተጠበቀ የበር ስጋ ወጥ ከእንጀራ ጋር' },
    icon: '🍖',
    image: '/assets/images/food/main-meals/red-stew.jpeg',
    preparationTime: 18,
    isAvailable: true,
  },
  {
    name: { en: 'Shiro Feses', am: 'ሽሮ ፈሰስ' },
    category: 'main-meals',
    price: 110,
    description: { en: 'Traditional chickpea flour stew with spiced butter', am: 'በቅቤ የተጠበቀ ባህላዊ የሽንቲ ወጥ' },
    icon: '🍲',
    image: '/assets/images/food/main-meals/shiro-feses.jpg',
    preparationTime: 12,
    isAvailable: true,
  },
  {
    name: { en: 'Tomato Sauce', am: 'የቲማቲም ጣዋት' },
    category: 'main-meals',
    price: 90,
    description: { en: 'Rich tomato sauce with herbs and spices', am: 'በሽብርዎች እና በርበሬ የተጠበቀ ጥሩ የቲማቲም ጣዋት' },
    icon: '🍅',
    image: '/assets/images/food/main-meals/tomato-sauce.jpeg',
    preparationTime: 10,
    isAvailable: true,
  },
  {
    name: { en: 'Vegetables with Meat', am: 'አትክልቶች ከስጋ' },
    category: 'main-meals',
    price: 145,
    description: {
      en: 'Mixed vegetables sautéed with tender beef strips',
      am: 'በቅቤ እና በርበሬ የተጠበቁ የተለያዩ አትክልቶች ከጣፋጭ ስጋ ጋር',
    },
    icon: '🥘',
    image: '/assets/images/food/main-meals/vegetables-with-meat.jpeg',
    preparationTime: 15,
    isAvailable: true,
  },

  // SNACKS
  {
    name: { en: 'Avocado with Injera', am: 'አቮካዶ ከእንጀራ' },
    category: 'snacks',
    price: 70,
    description: { en: 'Fresh avocado slices served with traditional injera', am: 'ትኩስ የአቮካዶ ክፍሎች ከባህላዊ እንጀራ ጋር' },
    icon: '🥑',
    image: '/assets/images/food/snacks/Avocado with injera.jpg',
    preparationTime: 5,
    isAvailable: true,
  },
  {
    name: { en: 'Meat Sandwich', am: 'የስጋ ሳንድዊች' },
    category: 'snacks',
    price: 85,
    description: { en: 'Grilled meat sandwich with vegetables and sauce', am: 'የተቀለበ ስጋ ሳንድዊች ከአትክልቶች እና ጣዋት ጋር' },
    icon: '🥪',
    image: '/assets/images/food/snacks/meat-sandwich.jpg',
    preparationTime: 8,
    isAvailable: true,
  },
];

const users = [
  {
    name: 'Admin User',
    email: 'admin@cafeteria.com',
    phone: '0911223344',
    password: 'password123',
    role: 'admin',
    balance: 5000,
    status: 'ACTIVE',
  },
  {
    name: 'Kitchen Staff',
    email: 'kitchen@cafeteria.com',
    phone: '0911556677',
    password: 'password123',
    role: 'kitchen',
    balance: 0,
    status: 'ACTIVE',
  },
  {
    name: 'Customer User',
    email: 'customer@cafeteria.com',
    phone: '0922334455',
    password: 'password123',
    role: 'customer',
    balance: 1000,
    status: 'ACTIVE',
  },
  {
    name: 'Delivery Staff',
    email: 'delivery@cafeteria.com',
    phone: '0933445566',
    password: 'password123',
    role: 'delivery',
    balance: 0,
    status: 'ACTIVE',
  },
];

const seedData = async () => {
  try {
    console.log('Connecting to database...');
    await connectDatabase();
    console.log('Connected.');

    // Upsert categories (idempotent, keeps existing categories untouched)
    console.log('Seeding categories...');
    let categoryCount = 0;
    for (const category of categories) {
      await Category.findOneAndUpdate(
        { id: category.id },
        { $set: category },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      categoryCount++;
    }
    console.log(`Ensured ${categoryCount} categories (breakfast, main-meals, fasting, beverages, snacks).`);

    // Upsert menu items (idempotent) - items are always visible:
    // they carry stock + AVAILABLE so the customer /menu endpoint returns them.
    console.log('Seeding menu items...');
    let itemCount = 0;
    for (const item of menuItems) {
      await MenuItem.findOneAndUpdate(
        { 'name.en': item.name.en, category: item.category },
        {
          $set: {
            ...item,
            availability: item.availability !== undefined ? item.availability : true,
            isAvailable: item.isAvailable !== undefined ? item.isAvailable : true,
            isActive: true,
            availabilityStatus: 'AVAILABLE',
            stockQuantity: 50,
            lowStockThreshold: 10,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      itemCount++;
    }
    console.log(`Ensured ${itemCount} menu items across all 5 food categories.`);

    // Create users only if neither email nor phone already exists
    // (keeps existing accounts untouched, avoids unique-phone collisions).
    console.log('Seeding default users...');
    let userCount = 0;
    for (const u of users) {
      const existing = await User.findOne({ $or: [{ email: u.email }, { phone: u.phone }] }).select('_id');
      if (!existing) {
        await User.create(u);
        userCount++;
      }
    }
    console.log(`Created ${userCount} missing default user(s).`);

    console.log('Database seeded successfully! 🎉');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding database:', error);
    process.exit(1);
  }
};

seedData();
