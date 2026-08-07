/**
 * ProcessedMessagesService.gs — ADR-023
 * Webhook Idempotency
 */
const ProcessedMessagesService = {

  DUPLICATE_WINDOW_MS: 300000,

  isDuplicate: function(messageId, phone, message) {
    try {
      var props = PropertiesService.getScriptProperties();
      var key = this._buildKey(messageId, phone, message);
      var storedMs = props.getProperty(key);
      if (!storedMs) return false;
      var elapsed = Clock.now().getTime() - parseInt(storedMs, 10);
      return elapsed < this.DUPLICATE_WINDOW_MS;
    } catch (e) {
      return false;
    }
  },

  markProcessed: function(messageId, phone, message) {
    try {
      var props = PropertiesService.getScriptProperties();
      var key = this._buildKey(messageId, phone, message);
      props.setProperty(key, String(Clock.now().getTime()));
    } catch (e) {
      // فشل التخزين ليس fatal
    }
  },

  _buildKey: function(messageId, phone, message) {
    if (messageId) return 'msg_' + messageId;
    var nowMs = Clock.now().getTime();
    var fingerprint = (phone || '') + '|' + (message || '') + '|' + Math.floor(nowMs / 60000);
    var hash = '';
    for (var i = 0; i < fingerprint.length; i++) {
      hash += fingerprint.charCodeAt(i).toString(36);
    }
    return 'msg_' + hash.substring(0, 30);
  }
};
