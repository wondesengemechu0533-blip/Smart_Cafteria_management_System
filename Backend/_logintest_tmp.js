require("dotenv").config();
const mongoose = require("mongoose");
const http = require("http");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const User = require("./src/models/User");
  await User.deleteOne({ email: "logintest@example.com" });
  await User.create({ name: "Login Test", email: "logintest@example.com", phone: "+251911000999", password: "TestPass123!", role: "customer", status: "ACTIVE", isActive: true });
  console.log("user created");
  await mongoose.disconnect();
  const body = JSON.stringify({ identifier: "logintest@example.com", password: "TestPass123!" });
  const req = http.request({ hostname: "127.0.0.1", port: 5000, path: "/api/v1/auth/login", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => { console.log("STATUS:" + res.statusCode); console.log("BODY:" + d.slice(0, 300)); });
  });
  req.on("error", (e) => console.log("REQERR:" + e.message));
  req.write(body); req.end();
})();
