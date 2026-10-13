const mongoose = require("mongoose");
(async () => {
  await mongoose.connect("mongodb://127.0.0.1:27017/smart_cafeteria");
  const r = await mongoose.connection.collection("orders").deleteMany({ orderId: { $regex: "^__idx_probe_" } });
  console.log("removed leftover probe docs: " + r.deletedCount);
  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
