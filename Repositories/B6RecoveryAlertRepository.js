/**
 * B6RecoveryAlertRepository
 *
 * ADMIN_PHONE is used only as an existing operational notification channel.
 * It is never interpreted as recovery authorization or operator identity.
 */
const B6RecoveryAlertRepository = {
  notifyRecoveryRequired: function(payload) {
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

      return WhatsAppAdapter.sendMessage(adminPhone, message);
    } catch (e) {
      return Result.fail('B6_RECOVERY_ALERT_FAILED', e.message, e.stack);
    }
  }
};
