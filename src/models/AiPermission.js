const mongoose = require('mongoose');

// Bảng Phân quyền AI: mỗi user một document, chỉ chứa boolean quyền của trợ lý.
const aiPermissionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  contactsRead: { type: Boolean, default: false },
  messagesRead: { type: Boolean, default: false },
  messagesDraft: { type: Boolean, default: false },
  messagesSend: { type: Boolean, default: false },
  callsStart: { type: Boolean, default: false },
  callsEnd: { type: Boolean, default: false },
  version: { type: Number, default: 0 },
},{ timestamps: true });

module.exports = mongoose.model('AiPermission', aiPermissionSchema);
