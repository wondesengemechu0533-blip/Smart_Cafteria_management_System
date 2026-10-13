/**
 * One-off migration: correct the default cafeteria's coordinates.
 *
 * The default cafeteria was created with Debre Berhan coordinates
 * (9.6797, 39.5328) while the business operates in Addis Ababa. Because the
 * delivery-range check measures from the cafeteria, every customer in Addis
 * Ababa computed as ~113 km away and was rejected with
 * "That address is beyond our 10 km delivery range."
 *
 * This script sets the default cafeteria to its real operating city. It is
 * idempotent: it only rewrites a cafeteria whose coordinates are still the
 * known-bad Debre Berhan pair, so it will never clobber a cafeteria that has
 * since been given a deliberate location.
 *
 * Usage: node scripts/fix-cafeteria-coordinates.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDatabase = require('../src/config/database');
const Cafeteria = require('../src/models/Cafeteria');

// The known-bad fallback that caused the false out-of-range rejections.
const BAD_LATITUDE = 9.6797;
const BAD_LONGITUDE = 39.5328;

// The cafeteria's real operating city (Addis Ababa), matching the centre the
// delivery tracking map already uses.
const CORRECT_LATITUDE = 9.03;
const CORRECT_LONGITUDE = 38.74;

(async () => {
  await connectDatabase();

  const cafeteria = await Cafeteria.findOne({ isDefault: true });
  if (!cafeteria) {
    console.log('No default cafeteria found - nothing to fix.');
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log(`Default cafeteria: ${cafeteria.name} (${cafeteria._id})`);
  console.log(`  current: lat=${cafeteria.latitude} lng=${cafeteria.longitude}`);

  const isBad =
    Number(cafeteria.latitude) === BAD_LATITUDE && Number(cafeteria.longitude) === BAD_LONGITUDE;

  if (!isBad) {
    console.log('  Coordinates are not the known-bad Debre Berhan pair - leaving them untouched.');
    await mongoose.disconnect();
    process.exit(0);
  }

  cafeteria.latitude = CORRECT_LATITUDE;
  cafeteria.longitude = CORRECT_LONGITUDE;
  await cafeteria.save();

  console.log(`  updated: lat=${cafeteria.latitude} lng=${cafeteria.longitude}`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
