/**
 * B6RecoveryAlertRepository
 *
 * Application-facing notification boundary. External notification transport
 * details remain inside Infrastructure/B6RecoveryAlert.
 */
const B6RecoveryAlertRepository = {
  notifyRecoveryRequired: function(payload) {
    return B6RecoveryAlert.notifyRecoveryRequired(payload);
  }
};
