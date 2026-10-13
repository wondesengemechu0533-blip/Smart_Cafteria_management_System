require('dotenv').config();
const mongoose = require('mongoose');
const connectDatabase = require('../config/database');
const MenuItem = require('../models/MenuItem');

const fixAvailability = async () => {
  try {
    await connectDatabase();

    await mongoose.connection.db
      .listCollections({ name: 'menuitems' })
      .next()
      .catch(() => null);

    // Every item that is still marked as available via the legacy boolean flags
    // (availability / isAvailable) but carries the old OUT_OF_STOCK default or
    // zero stock should be treated as available so it appears in the customer
    // /menu endpoint (which filters on availabilityStatus + stockQuantity > 0).
    const result = await MenuItem.updateMany(
      {
        $or: [
          { availabilityStatus: 'OUT_OF_STOCK', $or: [{ availability: true }, { isAvailable: true }] },
          { stockQuantity: 0, $or: [{ availability: true }, { isAvailable: true }] },
        ],
      },
      {
        $set: {
          availabilityStatus: 'AVAILABLE',
          stockQuantity: 50,
          lowStockThreshold: 10,
          availability: true,
          isAvailable: true,
        },
      }
    );
    console.log(`Fixed ${result.modifiedCount} menu item(s) to AVAILABLE with stock 50.`);

    const cabbage = await MenuItem.findOneAndUpdate(
      { 'name.en': 'Cabbage with Meat' },
      {
        $set: {
          availability: true,
          isAvailable: true,
          availabilityStatus: 'AVAILABLE',
          stockQuantity: 50,
          lowStockThreshold: 10,
        },
      },
      { new: true }
    );
    if (cabbage) {
      console.log(`"${cabbage.name.en}" is now AVAILABLE (stock ${cabbage.stockQuantity}).`);
    } else {
      console.log('WARNING: "Cabbage with Meat" not found in the database.');
    }

    await mongoose.connection.close();
    console.log('Done.');
    process.exit(0);
  } catch (error) {
    console.error('Fix failed:', error.message);
    process.exit(1);
  }
};

fixAvailability();
