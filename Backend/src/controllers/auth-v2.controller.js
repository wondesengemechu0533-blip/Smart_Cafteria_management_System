const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { logAction } = require('../utils/audit');

const tokenFor = (user) =>
  jwt.sign({ id: user._id.toString(), role: user.role, name: user.name, email: user.email }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  role: user.role,
});

exports.register = async (req, res) => {
  try {
    const { name, email, phone, password, confirmPassword } = req.body;
    if (!name || !email || !phone || !password || password !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Valid registration fields are required' });
    }
    const user = await User.create({ name, email, phone, password });
    return res.status(201).json({ success: true, token: tokenFor(user), user: publicUser(user) });
  } catch (error) {
    return res.status(error.code === 11000 ? 409 : 400).json({ success: false, message: error.message });
  }
};

exports.login = async (req, res) => {
  try {
    const identifier = req.body.email || req.body.identifier;
    const { password } = req.body;
    const user = await User.findOne({ $or: [{ email: identifier }, { phone: identifier }] }).select('+password');
    if (!user || !(await bcrypt.compare(password || '', user.password))) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    if (user.role === 'ADMIN' || user.role === 'admin') {
      await logAction({
        req,
        action: 'ADMIN_LOGIN',
        entityType: 'User',
        entityId: String(user._id),
        description: `${user.name} (${user.email}) signed in as Administrator`,
      });
    }
    return res.json({ success: true, token: tokenFor(user), user: publicUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Unable to log in' });
  }
};

exports.getMe = async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  return res.json({ success: true, user: publicUser(user) });
};

exports.logout = (req, res) => res.json({ success: true, message: 'Logged out' });
