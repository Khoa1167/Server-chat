const mongoose = require('mongoose');

// Danh mục quyền của trợ lý: map capability → trường boolean trong AiPermission và các action được phép.
const aiCapabilitySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, trim: true, maxlength: 64 },
  field: { type: String, required: true, trim: true, maxlength: 64 },
  label: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, required: true, trim: true, maxlength: 500 },
  tier: { type: Number, enum: [1, 2, 3], required: true },
  actions: [{ type: String, trim: true, maxlength: 64 }],
  order: { type: Number, required: true },
}, { timestamps: true });

module.exports = mongoose.model('AiCapability', aiCapabilitySchema);
