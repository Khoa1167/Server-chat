const mongoose = require('mongoose');

const friendshipSchema = new mongoose.Schema({
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  receiver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected'],
    default: 'pending',
  },
  senderAlias: {
    type: String,
    default: '',
  },
  receiverAlias: {
    type: String,
    default: '',
  },
  combinationKey: {
    type: String,
    unique: true,
  }
}, { timestamps: true });

// Pre-save hook để tạo combinationKey duy nhất cho cặp sender-receiver
friendshipSchema.pre('save', function() {
  if (this.sender && this.receiver) {
    const ids = [this.sender.toString(), this.receiver.toString()].sort();
    this.combinationKey = ids.join('_');
  }
});

friendshipSchema.index({ sender: 1, receiver: 1 }, { unique: true });

module.exports = mongoose.model('Friendship', friendshipSchema);