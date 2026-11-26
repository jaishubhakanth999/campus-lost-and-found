const router = require("express").Router();
const Item = require("../models/Item");
const Claim = require("../models/Claim");
const User = require("../models/User");
const { protect, adminOnly } = require("../middleware/auth");

router.use(protect, adminOnly);

router.get("/stats", async (req, res, next) => {
  try {
    const [users, items, lost, found, pendingClaims, returned] = await Promise.all([
      User.countDocuments(), Item.countDocuments(), Item.countDocuments({ type: "lost" }),
      Item.countDocuments({ type: "found" }), Claim.countDocuments({ status: "pending" }),
      Item.countDocuments({ status: "returned" })
    ]);
    res.json({ users, items, lost, found, pendingClaims, returned });
  } catch (error) { next(error); }
});

router.get("/items", async (req, res, next) => {
  try {
    const items = await Item.find().populate("owner", "name email").sort({ createdAt: -1 });
    res.json({ items });
  } catch (error) { next(error); }
});

router.get("/claims", async (req, res, next) => {
  try {
    const claims = await Claim.find().populate("item").populate("claimant", "name email").sort({ createdAt: -1 });
    res.json({ claims });
  } catch (error) { next(error); }
});

router.patch("/items/:id/status", async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!["open", "claimed", "returned", "closed"].includes(status)) return res.status(400).json({ message: "Invalid item status" });
    const item = await Item.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!item) return res.status(404).json({ message: "Item not found" });
    res.json({ message: "Item status updated", item });
  } catch (error) { next(error); }
});

module.exports = router;
