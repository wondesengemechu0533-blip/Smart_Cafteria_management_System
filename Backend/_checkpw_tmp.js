require("dotenv").config();
const mongoose = require("mongoose");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const User = require("./src/models/User");
  const users = await User.find({}).select("email phone role password").lean();
  console.log("TOTAL USERS: " + users.length);
  users.slice(0, 25).forEach((u) => {
    console.log((u.email || u.phone) + " [" + u.role + "] pw:" + (u.password ? "SET(" + String(u.password).slice(0, 7) + ")" : "MISSING"));
  });
  const missing = users.filter((u) => !u.password);
  console.log("MISSING_PASSWORD_COUNT: " + missing.length);
  await mongoose.disconnect();
})();
