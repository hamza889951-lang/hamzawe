const SlotRepository = {

  findById: function(slotId) {
    try {
      var result = GoogleSheets.findRowByColumn(Config.VOCABULARY.SHEETS.AVAILABILITY, 'slot_id', slotId);
      return result ? result : null;
    } catch (e) {
      return null;
    }
  },

  findByStatus: function(status) {
    try {
      return GoogleSheets.queryRows(Config.VOCABULARY.SHEETS.AVAILABILITY, function(row) {
        return row.status === status;
      });
    } catch (e) {
      return [];
    }
  },

  findAvailableByDate: function(dateStr) {
    try {
      return GoogleSheets.queryRows(Config.VOCABULARY.SHEETS.AVAILABILITY, function(row) {
        if (row.date !== dateStr) return false;
        if (row.status !== Config.VOCABULARY.STATUS.FREE) return false;
        if (!SlotRepository._isAvailable(row.is_available)) return false;
        return true;
      });
    } catch (e) {
      return [];
    }
  },

  findByPhoneAndStatus: function(phone, status) {
    try {
      var results = GoogleSheets.queryRows(Config.VOCABULARY.SHEETS.AVAILABILITY, function(row) {
        return row.phone === phone && row.status === status;
      });
      return results.length ? results[0] : null;
    } catch (e) {
      return null;
    }
  },

  /**
   * Result-based read for callers that must distinguish an empty result
   * from a storage failure. The legacy query() contract remains unchanged.
   */
  queryResult: function(predicateFn) {
    try {
      var rows = GoogleSheets.queryRows(
        Config.VOCABULARY.SHEETS.AVAILABILITY,
        predicateFn
      );
      return Result.ok(rows);
    } catch (e) {
      return Result.fail('UNEXPECTED_ERROR', e.message, e.stack);
    }
  },

  query: function(predicateFn) {
    var result = SlotRepository.queryResult(predicateFn);
    return result.ok ? result.data : [];
  },

  atomicUpdate: function(slotId, decisionFn) {
    return Lock.runExclusive('slot:' + slotId, function() {
      var slot = SlotRepository.findById(slotId);
      if (!slot) {
        return Result.fail('SLOT_NOT_FOUND', 'Slot ' + slotId + ' does not exist');
      }
      var decision = decisionFn(slot);
      if (!decision.ok) return decision;

      var updated = GoogleSheets.updateRowByColumn(
        Config.VOCABULARY.SHEETS.AVAILABILITY, 'slot_id', slotId, decision.data
      );

      if (!updated) {
        return Result.fail(
          'UPDATE_FAILED',
          'Failed to update slot ' + slotId + ' during atomicUpdate',
          { slotId: slotId, data: decision.data }
        );
      }

      return Result.ok(Object.assign({ slotId: slotId }, decision.data));
    });
  },

  insert: function(slotFields) {
    var record = Object.assign(
      { slot_id: IdGenerator.generateSlotId(), status: Config.VOCABULARY.STATUS.FREE },
      slotFields
    );
    GoogleSheets.appendRow(Config.VOCABULARY.SHEETS.AVAILABILITY, record);
    return Result.ok(record);
  },

  _isAvailable: function(value) {
    if (value === true) return true;
    if (typeof value === 'string') {
      var trimmed = value.trim().toUpperCase();
      if (trimmed === 'TRUE') return true;
    }
    return false;
  }
};

SlotRepository.findLatestSortKey = function() {
  var all = GoogleSheets.getAllRows(Config.VOCABULARY.SHEETS.AVAILABILITY);
  if (all.length === 0) return Result.ok(null);

  var maxKey = null;
  for (var i = 0; i < all.length; i++) {
    var key = all[i].sort_key;
    if (key && (maxKey === null || key > maxKey)) {
      maxKey = key;
    }
  }
  return Result.ok(maxKey);
};

SlotRepository.insertBatch = function(slots) {
  if (!slots || slots.length === 0) return Result.ok({ inserted: 0 });

  var headers = GoogleSheets.getHeaders(Config.VOCABULARY.SHEETS.AVAILABILITY);
  var rows = slots.map(function(slot) {
    return headers.map(function(h) {
      return slot.hasOwnProperty(h) ? slot[h] : '';
    });
  });

  return GoogleSheets.appendRows(Config.VOCABULARY.SHEETS.AVAILABILITY, rows);
};
