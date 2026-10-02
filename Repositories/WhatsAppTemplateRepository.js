/**
 * WhatsAppTemplateRepository
 *
 * Deployment configuration boundary for approved Meta WhatsApp templates.
 */
const WhatsAppTemplateRepository = {
  getTemplate: function(kind, options) {
    options = options || {};
    var props = PropertiesService.getScriptProperties();
    var suffix = String(kind || 'GENERIC_PROACTIVE').toUpperCase().replace(/[^A-Z0-9_]/g, '_');

    var name = options.templateName ||
      props.getProperty('WHATSAPP_TEMPLATE_' + suffix + '_NAME');
    var language = options.templateLanguage ||
      props.getProperty('WHATSAPP_TEMPLATE_' + suffix + '_LANGUAGE') ||
      'ar';

    if (!name) {
      return Result.fail(
        'WHATSAPP_TEMPLATE_REQUIRED',
        'A WhatsApp template is required for proactive messaging outside the service window',
        { kind: kind }
      );
    }

    var parameters = Array.isArray(options.templateParameters)
      ? options.templateParameters.map(function(value) {
          return value === null || value === undefined ? '' : String(value);
        })
      : [];

    var buttonPayloads = Array.isArray(options.buttonPayloads)
      ? options.buttonPayloads.map(function(value) {
          return value === null || value === undefined ? '' : String(value);
        })
      : [];

    if (buttonPayloads.length > 2) {
      return Result.fail(
        'WHATSAPP_TEMPLATE_INVALID',
        'At most two Quick Reply payloads are supported',
        { kind: kind, count: buttonPayloads.length }
      );
    }

    return Result.ok({
      name: name,
      language: language,
      parameters: parameters,
      buttonPayloads: buttonPayloads
    });
  }
};
