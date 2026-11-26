const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Item = require("../models/Item");
const Claim = require("../models/Claim");
const { protect, adminOnly } = require("../middleware/auth");

const uploadDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPG, PNG or WEBP images are allowed"));
  }
});

router.get("/", async (req, res, next) => {
  try {
    const { search, category, location, type, status, sort } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (location) filter.location = { $regex: location, $options: "i" };
    if (type) filter.type = type;
    if (status) filter.status = status;
    if (search) filter.$or = [
      { title: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
      { location: { $regex: search, $options: "i" } }
    ];
    const items = await Item.find(filter).populate("owner", "name").sort(sort === "oldest" ? { date: 1 } : { createdAt: -1 }).limit(100);
    res.json({ count: items.length, items });
  } catch (error) { next(error); }
});

router.get("/mine", protect, async (req, res, next) => {
  try {
    const items = await Item.find({ owner: req.user._id }).sort({ createdAt: -1 });
    res.json({ items });
  } catch (error) { next(error); }
});

router.post("/", protect, upload.single("image"), async (req, res, next) => {
  try {
    const { title, category, description, location, date, type } = req.body;
    if (!title || !category || !description || !location || !date || !type) {
      return res.status(400).json({ message: "Please complete all required fields" });
    }
    const item = await Item.create({
      title, category, description, location, date, type,
      image: req.file ? `/uploads/${req.file.filename}` : "",
      owner: req.user._id
    });
    res.status(201).json({ message: "Item report created", item });
  } catch (error) { next(error); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const item = await Item.findById(req.params.id).populate("owner", "name email");
    if (!item) return res.status(404).json({ message: "Item not found" });
    res.json({ item });
  } catch (error) { next(error); }
});

router.patch("/:id", protect, async (req, res, next) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Item not found" });
    if (String(item.owner) !== String(req.user._id) && req.user.role !== "admin") {
      return res.status(403).json({ message: "You cannot edit this item" });
    }
    const allowed = ["title", "category", "description", "location", "date", "type", "status"];
    allowed.forEach(key => { if (req.body[key] !== undefined) item[key] = req.body[key]; });
    await item.save();
    res.json({ message: "Item updated", item });
  } catch (error) { next(error); }
});

router.delete("/:id", protect, async (req, res, next) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Item not found" });
    if (String(item.owner) !== String(req.user._id) && req.user.role !== "admin") {
      return res.status(403).json({ message: "You cannot delete this item" });
    }
    await Claim.deleteMany({ item: item._id });
    await item.deleteOne();
    res.json({ message: "Item deleted" });
  } catch (error) { next(error); }
});

module.exports = router;
