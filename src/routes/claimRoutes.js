const router = require("express").Router();
const Claim = require("../models/Claim");
const Item = require("../models/Item");
const { protect } = require("../middleware/auth");

router.post("/", protect, async (req, res, next) => {
  try {
    const { itemId, message, proof } = req.body;
    if (!itemId || !message) return res.status(400).json({ message: "Item and claim message are required" });
    const item = await Item.findById(itemId);
    if (!item) return res.status(404).json({ message: "Item not found" });
    if (String(item.owner) === String(req.user._id)) return res.status(400).json({ message: "You cannot claim your own listing" });
    if (item.status !== "open") return res.status(400).json({ message: "This item is no longer open for claims" });
    const existing = await Claim.findOne({ item: itemId, claimant: req.user._id, status: "pending" });
    if (existing) return res.status(409).json({ message: "You already have a pending claim for this item" });
    const claim = await Claim.create({ item: itemId, claimant: req.user._id, message, proof: proof || "" });
    res.status(201).json({ message: "Claim submitted for review", claim });
  } catch (error) { next(error); }
});

router.get("/mine", protect, async (req, res, next) => {
  try {
    const claims = await Claim.find({ claimant: req.user._id }).populate("item").sort({ createdAt: -1 });
    res.json({ claims });
  } catch (error) { next(error); }
});

router.get("/received", protect, async (req, res, next) => {
  try {
    const owned = await Item.find({ owner: req.user._id }).select("_id");
    const claims = await Claim.find({ item: { $in: owned.map(x => x._id) } })
      .populate("item").populate("claimant", "name email").sort({ createdAt: -1 });
    res.json({ claims });
  } catch (error) { next(error); }
});

router.patch("/:id/status", protect, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!["approved", "rejected"].includes(status)) return res.status(400).json({ message: "Status must be approved or rejected" });
    const claim = await Claim.findById(req.params.id).populate("item");
    if (!claim) return res.status(404).json({ message: "Claim not found" });
    if (String(claim.item.owner) !== String(req.user._id) && req.user.role !== "admin") {
      return res.status(403).json({ message: "Only the listing owner or admin can review this claim" });
    }
    claim.status = status;
    await claim.save();
    if (status === "approved") {
      await Item.findByIdAndUpdate(claim.item._id, { status: "claimed" });
      await Claim.updateMany({ item: claim.item._id, _id: { $ne: claim._id }, status: "pending" }, { status: "rejected" });
    }
    res.json({ message: `Claim ${status}`, claim });
  } catch (error) { next(error); }
});

module.exports = router;
