const WhatsAppTemplateCatalog = {
  KINDS: {
    WELCOME: 'WELCOME',
    BOOKING_CONFIRMATION: 'BOOKING_CONFIRMATION',
    BOOKED_ACTIONS: 'BOOKED_ACTIONS',
    CHANGE_CONFIRMATION: 'CHANGE_CONFIRMATION',
    DISRUPTION_PROPOSAL: 'DISRUPTION_PROPOSAL',
    DISRUPTION_NO_ALTERNATIVE: 'DISRUPTION_NO_ALTERNATIVE',
    REMINDER: 'REMINDER',
    REMINDER_NO_BUS: 'REMINDER_NO_BUS'
  },
  PAYLOADS: {
    CONFIRM: 'HAMZAWE_CONFIRM',
    CHANGE: 'HAMZAWE_CHANGE',
    CANCEL: 'HAMZAWE_CANCEL',
    DECLINE: 'HAMZAWE_DECLINE',
    START_BOOKING: 'HAMZAWE_START_BOOKING'
  },
  toCanonicalMessage: function(payload) {
    switch (String(payload || '')) {
      case this.PAYLOADS.CONFIRM: return '1';
      case this.PAYLOADS.CHANGE: return '2';
      case this.PAYLOADS.CANCEL: return '3';
      case this.PAYLOADS.DECLINE: return '2';
      case this.PAYLOADS.START_BOOKING: return 'START_BOOKING';
      default: return null;
    }
  }
};
