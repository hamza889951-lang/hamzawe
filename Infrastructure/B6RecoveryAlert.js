/**
 * B6RecoveryAlert
 *
 * Infrastructure-only operational notification adapter. ADMIN_PHONE is a
 * destination for an existing notification channel, never an authorization or
 * Doctor identity source.
 */
const B6RecoveryAlert = {
  notifyRecoveryRequired: function(payload, sendFn) {
    if (typeof sendFn !== 'function') {
      return Result.fail(
        'B6_RECOVERY_ALERT_SENDER_MISSING',
        'A provider-neutral outbound sender is required'
      );
    }
    try {
      var properties = PropertiesService.getScriptProperties();
      var adminPhone = properties.getProperty('ADMIN_PHONE');
      if (!adminPhone) {
        return Result.fail(
          'B6_RECOVERY_ALERT_DESTINATION_MISSING',
          'No operational notification destination is configured'
        );
      }

      var message = 'B6 RECOVERY REQUIRED\n' +
        'Operation: ' + (payload.operationId || '') + '\n' +
        'Case: ' + (payload.recoveryCaseId || '') + '\n' +
        'Reason: ' + (payload.reason || 'UNRESOLVED');

      return sendFn(adminPhone, message, { kind: 'B6_RECOVERY' });
    } catch (e) {
      return Result.fail('B6_RECOVERY_ALERT_FAILED', e.message, e.stack);
    }
  }
};
