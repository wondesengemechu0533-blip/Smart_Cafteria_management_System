require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI).then(() => {
  const User = require('./src/models/User');
  return User.findOne({ email: 'admin@cafeteria.com' });
}).then(user => {
  console.log('User found:', user ? user.email + ' role=' + user.role : 'not found');
  mongoose.connection.close();
}).catch(e => console.error('Error:', e.message));