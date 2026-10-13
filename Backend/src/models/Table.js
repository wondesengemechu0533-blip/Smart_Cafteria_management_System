const mongoose = require('mongoose');

function escapeTableNumberRegex(value) {
  return String(value).replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

function getTableNumberCandidates(tableNumber) {
  const clean = String(tableNumber || '').trim();
  if (!clean) return [];

  const candidates = new Set([clean]);
  const numericMatch = clean.match(/^(?:table[\s_-]*)?0*(\d+)$/i) || clean.match(/^t[\s_-]*0*(\d+)$/i);
  if (numericMatch) {
    const number = numericMatch[1];
    const padded = [
      number,
      number.padStart(2, '0'),
      number.padStart(3, '0'),
    ];
    padded.forEach((value) => {
      candidates.add(value);
      candidates.add(`T-${value}`);
      candidates.add(`T${value}`);
    });
  }

  return Array.from(candidates);
}

/**
 * Table Schema - Cafeteria dine-in tables.
 *
 * Frontend Usage:
 * - admin/tables.html: Manage cafeteria tables
 */
const TableSchema = new mongoose.Schema(
  {
    tableNumber: {
      type: String,
      required: true,
      trim: true,
    },
    seats: {
      type: Number,
      default: 4,
      min: 1,
    },
    zone: {
      type: String,
      default: 'Main Hall',
      trim: true,
    },
    status: {
      type: String,
      enum: ['available', 'occupied', 'reserved', 'maintenance'],
      default: 'available',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    notes: {
      type: String,
      default: '',
    },
    cafeteriaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafeteria',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

TableSchema.statics.findByIdentifier = async function findByIdentifier(tableId, tableNumber) {
  const cleanId = String(tableId || '').trim();
  if (cleanId && mongoose.Types.ObjectId.isValid(cleanId)) {
    const table = await this.findById(cleanId);
    if (table) return table;
  }

  for (const candidate of getTableNumberCandidates(tableNumber)) {
    const table = await this.findOne({ tableNumber: candidate });
    if (table) return table;
    const caseInsensitiveTable = await this.findOne({
      tableNumber: { $regex: new RegExp('^' + escapeTableNumberRegex(candidate) + '$', 'i') },
    });
    if (caseInsensitiveTable) return caseInsensitiveTable;
  }

  return null;
};

TableSchema.index({ cafeteriaId: 1, tableNumber: 1 }, { unique: true });

module.exports = mongoose.model('Table', TableSchema);
