require('dotenv').config();
require('./src/config/database')();
const Table = require('./src/models/Table');

(async () => {
  const tables = await Table.find({}).sort({tableNumber: 1});
  console.log('Total tables:', tables.length);
  tables.forEach(t => console.log('Table:', t.tableNumber, 'cafeteriaId:', t.cafeteriaId, 'id:', t._id));
  const dupes = await Table.aggregate([
    {'$group': {'_id': {'cafeteriaId': '$cafeteriaId', tableNumber: '$tableNumber'}, count: {'$sum': 1}, ids: {'$push': '$_id'}}},
    {'$match': {count: {'$gt': 1}}}
  ]);
  console.log('Duplicates:', JSON.stringify(dupes, null, 2));
})();