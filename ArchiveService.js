/**
 * ArchiveService.js
 * أرشفة سجلات SYSTEM_LOG الأقدم من 90 يومًا.
 * لا نحذف قبل التحقق. التكرار في الأرشيف مقبول، الفقدان مرفوض.
 */
const ArchiveService = {

  RETENTION_MS: 90 * 24 * 60 * 60 * 1000,

  run: function() {
    var sheetName = Config.VOCABULARY.SHEETS.SYSTEM_LOG;
    var archiveName = 'SYSTEM_LOG_ARCHIVE';

    var allRows = GoogleSheets.getAllRows(sheetName);
    if (!allRows || allRows.length === 0) return Result.ok({ archived: 0, reason: 'Nothing to archive' });

    var cutoffMs = Clock.now().getTime() - this.RETENTION_MS;
    var oldRows = [];
    for (var i = 0; i < allRows.length; i++) {
      var row = allRows[i];
      var ts = row.timestamp;
      if (!ts) continue;
      var rowMs = (typeof ts === 'object') ? ts.getTime() : new Date(ts).getTime();
      if (isNaN(rowMs)) continue;
      if (rowMs < cutoffMs) { oldRows.push(row); }
    }

    if (oldRows.length === 0) return Result.ok({ archived: 0, reason: 'Nothing old enough to archive' });

    // تأكد من وجود ورقة الأرشيف
    var archiveSheet = this._ensureArchiveSheet(sheetName, archiveName);
    if (!archiveSheet) return Result.fail('ARCHIVE_SHEET_FAILED', 'Cannot create or access SYSTEM_LOG_ARCHIVE');

    // نسخ الصفوف القديمة إلى الأرشيف
    var headers = GoogleSheets.getHeaders(sheetName);
    var archiveRows = oldRows.map(function(row) {
      return headers.map(function(h) { return row.hasOwnProperty(h) ? row[h] : ''; });
    });

    var appendResult = GoogleSheets.appendRows(archiveName, archiveRows);
    if (!appendResult.ok) return Result.fail('ARCHIVE_WRITE_FAILED', 'Failed to write to archive', appendResult.error);

    // لا نحذف قبل التحقق
    if (appendResult.data.inserted !== oldRows.length) {
      return Result.fail('ARCHIVE_COUNT_MISMATCH', 'Written ' + appendResult.data.inserted + ' but expected ' + oldRows.length);
    }

    // حذف من الأسفل للأعلى
    var sortedByRow = oldRows.slice().sort(function(a, b) { return (b._rowNumber || 0) - (a._rowNumber || 0); });
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    for (var j = 0; j < sortedByRow.length; j++) {
      var rowNum = sortedByRow[j]._rowNumber;
      if (rowNum) { sheet.deleteRow(rowNum); }
    }

    LogRepository.write({
      timestamp: Clock.now(), command: 'ARCHIVE_RUN', phone: '', slotId: '',
      stage: 'END', success: true, durationMs: null,
      error: JSON.stringify({ archived: oldRows.length })
    });

    return Result.ok({ archived: oldRows.length });
  },

  _ensureArchiveSheet: function(sourceSheetName, archiveSheetName) {
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = spreadsheet.getSheetByName(archiveSheetName);
    if (sheet) return sheet;

    var sourceSheet = spreadsheet.getSheetByName(sourceSheetName);
    if (!sourceSheet) return null;

    var lastRow = sourceSheet.getLastRow();
    var headers = (lastRow >= 1) ? sourceSheet.getRange(1, 1, 1, sourceSheet.getLastColumn()).getValues()[0] : null;

    sheet = spreadsheet.insertSheet(archiveSheetName);
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    return sheet;
  }
};
