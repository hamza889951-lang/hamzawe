/**
 * ArchiveService.js
 * سياسة أرشفة سجلات SYSTEM_LOG الأقدم من 90 يومًا فقط.
 * لا يحتوي أي تفاصيل تخزين — كل شيء في LogArchiveRepository.
 * لا نحذف قبل التحقق. التكرار في الأرشيف مقبول، الفقدان مرفوض.
 */
const ArchiveService = {

  RETENTION_MS: 90 * 24 * 60 * 60 * 1000,

  run: function() {
    var cutoffMs = Clock.now().getTime() - this.RETENTION_MS;

    var findResult = LogArchiveRepository.findOlderThan(cutoffMs);
    if (!findResult.ok) return Result.fail('ARCHIVE_READ_FAILED', 'Failed to find old log records', findResult.error);

    var records = findResult.data.records;
    if (findResult.data.totalCount === 0) return Result.ok({ archived: 0, reason: 'Nothing to archive' });
    if (records.length === 0) return Result.ok({ archived: 0, reason: 'Nothing old enough to archive' });

    var appendResult = LogArchiveRepository.appendToArchive(records);
    if (!appendResult.ok) return appendResult;

    var deleteResult = LogArchiveRepository.deleteRecords(records);
    if (!deleteResult.ok) return deleteResult;

    LogRepository.write({
      timestamp: Clock.now(), command: 'ARCHIVE_RUN', phone: '', slotId: '',
      stage: 'END', success: true, durationMs: null,
      error: JSON.stringify({ archived: records.length })
    });

    return Result.ok({ archived: records.length });
  }
};
