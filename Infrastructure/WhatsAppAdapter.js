/**
 * WhatsAppAdapter.gs
 * الملف الوحيد المسموح له بمعرفة تفاصيل ultramsg.
 * ADR-007: أي تبديل لمزود واتساب يقتصر على هذا الملف فقط.
 */
const WhatsAppAdapter = {

  parseIncomingPayload: function(e) {
    try {
      const payload = JSON.parse(e.postData.contents);
      const data = payload.data;
      if (!data || !data.from || !data.body) return null;
      return {
        phone: data.from.replace('@c.us', ''),
        message: data.body,
        messageId: data.id || null
      };
    } catch (err) {
      return null;
    }
  },

  sendMessage: function(phone, text) {
    const props = PropertiesService.getScriptProperties();
    const instanceId = props.getProperty('ULTRAMSG_INSTANCE_ID');
    const token = props.getProperty('ULTRAMSG_TOKEN');
    const url = 'https://api.ultramsg.com/' + instanceId + '/messages/chat';

    const payload = { token: token, to: phone, body: text };

    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        payload: payload,
        muteHttpExceptions: true
      });
      const code = response.getResponseCode();
      if (code >= 200 && code < 300) {
        return Result.ok({ phone: phone });
      }
      return Result.fail('WHATSAPP_SEND_FAILED', 'HTTP ' + code, response.getContentText());
    } catch (e) {
      return Result.fail('WHATSAPP_SEND_ERROR', e.message, e.stack);
    }
  }
};
