require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('./src/models/Order');
const Delivery = require('./src/models/Delivery');
const User = require('./src/models/User');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const users = await User.find({ role: { $in: ['delivery','customer','kitchen'] } }).select('email role name').lean();
  console.log('USERS:', JSON.stringify(users, null, 1));
  const orders = await Order.find({ orderType: 'delivery' }).sort({ createdAt: -1 }).limit(8)
    .select('orderId status orderType userId deliveryStaffAssigned deliveryInfo customerLocation currentLocation createdAt').lean();
  console.log('ORDERS:', JSON.stringify(orders, null, 1));
  const dels = await Delivery.find({}).sort({ createdAt: -1 }).limit(8)
    .select('orderId order status deliveryPerson currentLocation destination createdAt').lean();
  console.log('DELIVERIES:', JSON.stringify(dels, null, 1));
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
