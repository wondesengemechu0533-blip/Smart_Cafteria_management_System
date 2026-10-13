require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI).then(() => {
  const User = require('./src/models/User');
  return User.find();
}).then(users => {
  console.log('All users count:', users.length);
  users.forEach(u => {
    console.log(' -', u.email, 'role:', u.role);
  });
  mongoose.connection.close();
}).catch(e => console.error('Error:', e.message));