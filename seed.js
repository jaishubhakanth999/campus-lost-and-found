const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("./src/models/User");
const Item = require("./src/models/Item");

const samples = [
  ["Black Samsung phone", "Electronics", "Black Samsung phone with a clear case.", "Central Library", "lost"],
  ["Blue water bottle", "Accessories", "Blue metal water bottle with stickers.", "Cafeteria", "found"],
  ["Data Structures textbook", "Books", "A Data Structures textbook with handwritten notes.", "Block A - Room 204", "lost"],
  ["Student ID card", "ID Cards", "University ID card found near the main entrance.", "Main Gate", "found"],
  ["Grey laptop bag", "Bags", "Grey laptop backpack with a small keychain.", "Computer Lab", "lost"],
  ["Wireless earbuds case", "Electronics", "White earbuds charging case.", "Auditorium", "found"],
  ["Black hoodie", "Clothing", "Black hoodie left after an afternoon class.", "Sports Complex", "lost"],
  ["Silver wrist watch", "Accessories", "Silver wrist watch found on a classroom desk.", "Block C", "found"],
  ["Notebook - Physics", "Books", "Blue notebook with Physics written on the cover.", "Study Hall", "lost"],
  ["Umbrella", "Other", "Navy blue folding umbrella.", "Bus Parking", "found"]
];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const email = process.env.ADMIN_EMAIL || "admin@saiuniversity.edu.in";
  const password = process.env.ADMIN_PASSWORD || "ChangeThisAdminPassword123!";
  let admin = await User.findOne({ email });
  if (!admin) admin = await User.create({ name: "Portal Admin", email, password: await bcrypt.hash(password, 12), role: "admin" });
  const count = await Item.countDocuments();
  if (count === 0) {
    await Item.insertMany(samples.map((x, i) => ({
      title: x[0], category: x[1], description: x[2], location: x[3],
      date: new Date(Date.now() - i * 86400000), type: x[4], owner: admin._id
    })));
    console.log("Inserted 10 sample items");
  } else console.log("Items already exist; seed data skipped");
  console.log(`Admin account: ${email}`);
  await mongoose.disconnect();
}
run().catch(err => { console.error(err); process.exit(1); });
