const mongoose = require('mongoose');

const aiConsentPolicySchema = new mongoose.Schema({
  scope: { type: String, enum: ['chatbot'], default: 'chatbot', required: true },
  version: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['draft', 'active', 'retired'], required: true },
  provider: { type: String, required: true, trim: true, maxlength: 100 },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  notice: { type: String, required: true, trim: true, maxlength: 1000 },
  promptLabel: { type: String, required: true, trim: true, maxlength: 160 },
  promptDescription: { type: String, required: true, trim: true, maxlength: 500 },
  historyLabel: { type: String, required: true, trim: true, maxlength: 160 },
  historyDescription: { type: String, required: true, trim: true, maxlength: 500 },
  inaccessibleData: [{ type: String, trim: true, maxlength: 200 }],
  activatedAt: { type: Date, default: null },
}, { timestamps: true });

aiConsentPolicySchema.index({ scope: 1, version: 1 }, { unique: true });
aiConsentPolicySchema.index(
  { scope: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);

module.exports = mongoose.model('AiConsentPolicy', aiConsentPolicySchema);
