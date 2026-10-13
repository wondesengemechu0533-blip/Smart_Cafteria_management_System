require("dotenv").config();
const mongoose = require("mongoose");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const User = require("./src/models/User");
  const u = await User.findOne({ role: "admin" }).select("email phone role status").lean();
  console.log("ADMIN:" + JSON.stringify(u));
  await mongoose.disconnect();
})();
