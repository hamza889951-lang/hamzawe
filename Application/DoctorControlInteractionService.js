/**
 * ═══════════════════════════════════════
 * CONTRACT — DoctorControlInteractionService
 * ═══════════════════════════════════════
 * M4-C Continuation — provider-neutral Doctor Control interaction
 * (legacy numeric + WhatsApp Interactive Intent) + read-only Preview → explicit Confirm → Commit.
 *
 * لماذا boundary جديد واحد بدلاً من توسيع DoctorControlEntry؟
 * DoctorControlEntry هو عقد M4-A مجمّد ومدموج: read-only، بلا مخازن،
 * بلا CommandExecutor، بلا أي mutation seam — وهذه القيود مفروضة
 * هيكليًا باختبارات M4-A المدموجة (M4A-P2 / M4A-X2 / M4A-DR2).
 * تدفق التفاعل يحتاج جلسة محادثة (ConversationRepository) وقراءة
 * الحجوزات للـimpact count (SlotRepository) والتزام via
 * DoctorScheduleCommandService — أي توسيع للـEntry كان سيعيد كتابة
 * حد M4-A المجمّد. لذلك: Entry يبقى كما هو، وهذا الملف هو الـboundary
 * الوحيد تحته. لا طبقة ثانية تؤدي نفس الدور.
 *
 * يضمن:
 * - الأرقام وInteractive Button IDs هي channel/presentation representations
 *   فقط؛ ما يصل حدود الـApplication هو Doctor Interaction Intent دلالي.
 *   WhatsApp transport IDs تبقى داخل WhatsAppAdapter boundary ولا تظهر
 *   في هذا الـprovider-neutral service. لا تنشئ الـIntents Domain Commands
 *   أو State Machine branches جديدة.
 * - Preview read-only بالكامل: لا Schedule Change persistence، لا
 *   Availability/Appointment/Calendar mutation — يعيد استخدام نفس
 *   builders/validation الالتزام عبر DoctorScheduleCommandService.preview*.
 * - impact = عدد الحجوزات المتأثرة فقط (لا أسماء مرضى ولا قائمة باصات).
 * - Commit فقط بعد تأكيد صريح، بنفس commandId المولّد عند الـpreview
 *   (duplicate confirm → IDEMPOTENT_REPLAY، لا سجل مكرر).
 * - Preview هو INFORMATIONAL preview (وليس commit-authoritative snapshot):
 *   لا يُمرَّر ناتج الـpreview إلى الـcommit إطلاقًا. عند التأكيد يُعاد بناء
 *   الأمر الدلالي من الـdraft بـasOf جديد من Clock.now()، ثم يعيد
 *   DoctorScheduleCommandService كامل الـvalidation/projection/conflict
 *   detection ضد الحالة الحالية داخل قفل الـscope. إذا تغيرت البيانات بين
 *   الـpreview والتأكيد فالـcommit يفشل بصدق (مثل SCHEDULE_INTENT_CONFLICT)
 *   ولا يُنفَّذ بناءً على preview قديم. impact count معلوماتي فقط وليس
 *   شرط commit.
 * - جلسة الطبيب في Conversations عبر bounded schema صريح
 *   (ConversationRepository.DOCTOR_SESSION_FIELDS) — fail-closed عند
 *   غياب الأعمدة.
 *
 * لا يضمن:
 * - أي authorization (M4-A) أو routing (Router) أو schedule semantics
 *   (DoctorScheduleCommandService / EffectiveScheduleService).
 * - أي Availability materialization (مرحلة لاحقة).
 */
const DoctorControlInteractionService = {

  DAY_LABELS: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],

  KIND_LABELS: {
    RECURRING: 'تغيير الجدول الأسبوعي',
    TEMPORARY_CLOSE: 'إغلاق مؤقت',
    TEMPORARY_OPEN: 'فتح استثنائي',
    CANCEL_CHANGE: 'إلغاء تغيير مجدول'
  },

  /**
   * نقطة الدخول الوحيدة بعد DoctorControlEntry.
   * @param {Object} controlContext — { actorId, scope } من M4-A
   * @param {string} message — نص رسالة الطبيب كما وصلت
   * @returns {Result} ok({ reply, controlState })
   */
  handle: function(controlContext, message) {
    if (!controlContext || typeof controlContext.actorId !== 'string' || !controlContext.actorId) {
      return Result.fail(
        'INVALID_CONTROL_CONTEXT',
        'Doctor interaction requires a control context from M4-A'
      );
    }
    var phone = controlContext.actorId;
    var text = typeof message === 'string' ? message.trim() : '';

    try { console.log('[HAMZAWE_DOCTOR_TRACE] ' + JSON.stringify({component:'DoctorControlInteractionService',stage:'BEFORE_GET_UX_SESSION',atMs:Clock.now().getTime()})); } catch (ignored) {}
    var sessionResult = ConversationRepository.getDoctorControlUxSession(phone);
    try { console.log('[HAMZAWE_DOCTOR_TRACE] ' + JSON.stringify({component:'DoctorControlInteractionService',stage:'AFTER_GET_UX_SESSION',atMs:Clock.now().getTime(),ok:!!sessionResult.ok,errorCode:sessionResult.error&&sessionResult.error.code||null,exists:!!(sessionResult.data&&sessionResult.data.exists),state:sessionResult.data&&sessionResult.data.state||null})); } catch (ignored) {}
    if (!sessionResult.ok) return sessionResult;
    var session = sessionResult.data;

    var states = Config.VOCABULARY.CONVERSATION_STATE;

    if (!session.exists || ConversationRepository.DOCTOR_STATES.indexOf(session.state) === -1) {
      return this._showMenu(phone);
    }

    if (session.state === states.DOCTOR_MENU) {
      return this._handleMenu(controlContext, phone, text);
    }
    if (session.state === states.DOCTOR_AWAITING_INPUT) {
      return this._handleInput(controlContext, phone, text, session.draft);
    }
    if (session.state === states.DOCTOR_AWAITING_CONFIRMATION) {
      return this._handleConfirmation(controlContext, phone, text, session.draft);
    }
    return this._showMenu(phone);
  },

  // ─────────────────────────────────────────────────────────
  // Menu
  // ─────────────────────────────────────────────────────────

  _menuText: function() {
    return 'قائمة تحكم الطبيب:\n' +
      '1) عرض جدول الدوام الحالي\n' +
      '2) تغيير الجدول الأسبوعي\n' +
      '3) إغلاق مؤقت\n' +
      '4) فتح استثنائي ليوم مغلق\n' +
      '5) إلغاء تغيير مجدول\n' +
      'أرسل رقم الخيار.';
  },

  _menuButtons: function() {
    return [
      { id: 'VIEW_SCHEDULE', title: 'عرض الجدول' },
      { id: 'CHANGE_SCHEDULE', title: 'تغيير الجدول' },
      { id: 'MORE', title: 'المزيد' }
    ];
  },

  _moreMenuText: function() {
    return 'المزيد من عمليات لوحة الطبيب:\n' +
      '3) إغلاق مؤقت\n' +
      '4) فتح استثنائي ليوم مغلق\n' +
      '5) إلغاء تغيير مجدول\n' +
      'أرسل رقم الخيار.';
  },

  _moreMenuButtons: function() {
    return [
      { id: 'TEMPORARY_CLOSE', title: 'إغلاق مؤقت' },
      { id: 'TEMPORARY_OPEN', title: 'فتح استثنائي' },
      { id: 'CANCEL_CHANGE', title: 'إلغاء تغيير' }
    ];
  },

  _showMenu: function(phone, prefix) {
    try { console.log('[HAMZAWE_DOCTOR_TRACE] ' + JSON.stringify({component:'DoctorControlInteractionService',stage:'BEFORE_SET_MENU_SESSION',atMs:Clock.now().getTime()})); } catch (ignored) {}
    var set = ConversationRepository.setDoctorControlSession(
      phone,
      Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_MENU,
      {}
    );
    try { console.log('[HAMZAWE_DOCTOR_TRACE] ' + JSON.stringify({component:'DoctorControlInteractionService',stage:'AFTER_SET_MENU_SESSION',atMs:Clock.now().getTime(),ok:!!set.ok,errorCode:set.error&&set.error.code||null})); } catch (ignored) {}
    if (!set.ok) return set;
    return Result.ok({
      reply: (prefix ? prefix + '\n\n' : '') + this._menuText(),
      controlState: Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_MENU,
      deliveryOptions: {
        interactiveButtons: this._menuButtons(),
        fallbackToText: true
      }
    });
  },

  _showMoreMenu: function(phone, prefix) {
    var set = ConversationRepository.setDoctorControlSession(
      phone,
      Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_MENU,
      {}
    );
    if (!set.ok) return set;
    return Result.ok({
      reply: (prefix ? prefix + '\n\n' : '') + this._moreMenuText(),
      controlState: Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_MENU,
      deliveryOptions: {
        interactiveButtons: this._moreMenuButtons(),
        fallbackToText: true
      }
    });
  },

  _handleMenu: function(controlContext, phone, text) {
    if (text === '1' || text === 'VIEW_SCHEDULE') {
      return this._renderCurrentSchedule(controlContext, phone);
    }
    if (text === '2') {
      return this._promptInput(phone, 'RECURRING',
        'تغيير الجدول الأسبوعي:\n' +
        'أرسل: أيام الدوام | نافذة الدوام | تاريخ البدء\n' +
        'الأيام أرقام (1=الأحد ... 7=السبت) مفصولة بفواصل.\n' +
        'مثال: 1,2,4 | 10:00-14:00 | 2026-09-15\n' +
        'ملاحظة: يبدأ التغيير من الساعة 00:00 بتوقيت بغداد في التاريخ المحدد.\n' +
        'أرسل 0 للرجوع.');
    }
    if (text === 'CHANGE_SCHEDULE') {
      return this._startRecurringGuided(phone);
    }
    if (text === '3') {
      return this._promptInput(phone, 'TEMPORARY_CLOSE',
        'إغلاق مؤقت:\n' +
        'ليوم كامل أرسل التاريخ فقط: 2026-09-20\n' +
        'وللفترة المحددة أرسل: 2026-09-20 10:00 | 2026-09-20 12:00\n' +
        '(النهاية غير مشمولة — [من، إلى))\n' +
        'أرسل 0 للرجوع.');
    }
    if (text === 'TEMPORARY_CLOSE') {
      return this._startTemporaryCloseGuided(phone);
    }
    if (text === '4' || text === 'TEMPORARY_OPEN') {
      return this._promptInput(phone, 'TEMPORARY_OPEN',
        'فتح استثنائي ليوم مغلق:\n' +
        'أرسل تاريخ اليوم: 2026-09-22\n' +
        'سيُفتح اليوم بنافذة الدوام المعتادة من الإعدادات (لا فتح جزئي).\n' +
        'أرسل 0 للرجوع.');
    }
    if (text === '5' || text === 'CANCEL_CHANGE') {
      return this._promptCancelList(controlContext, phone);
    }
    if (text === 'MORE') {
      return this._showMoreMenu(phone);
    }
    return this._showMenu(phone);
  },

  _promptInput: function(phone, kind, prompt) {
    var set = ConversationRepository.setDoctorControlSession(
      phone,
      Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT,
      { doctor_draft_kind: kind }
    );
    if (!set.ok) return set;
    return Result.ok({
      reply: prompt,
      controlState: Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT
    });
  },

  _renderCurrentSchedule: function(controlContext, phone) {
    var read = DoctorScheduleReadService.readCurrentEffectiveSchedule(controlContext);
    if (!read.ok) {
      return this._showMenu(phone, 'تعذر قراءة الجدول: ' + read.error.code);
    }
    var schedule = read.data;
    var openDays = [];
    var keys = EffectiveScheduleService.DAY_KEYS;
    for (var i = 0; i < keys.length; i++) {
      if (schedule.days[keys[i]] === true) openDays.push(this.DAY_LABELS[i]);
    }
    var summary = 'الجدول الحالي (من الإعدادات):\n' +
      'أيام الدوام: ' + (openDays.length ? openDays.join('، ') : 'لا يوجد') + '\n' +
      'نافذة الدوام: ' + schedule.workWindow.start + '–' + schedule.workWindow.end + '\n' +
      'مدة الفتحة: ' + schedule.slotDurationMinutes + ' دقيقة (من الإعدادات — غير قابلة للتغيير من هنا)';
    return this._showMenu(phone, summary);
  },

  // ─────────────────────────────────────────────────────────
  // Input → Preview
  // ─────────────────────────────────────────────────────────

  _handleInput: function(controlContext, phone, text, draft) {
    if (text === '0') return this._showMenu(phone);
    var kind = draft.doctor_draft_kind;
    if (draft.doctor_ux_step === 'EDIT') {
      if (text === 'EDIT_DAYS') return this._guidedPrompt(phone, 'RECURRING', 'DAYS', 'أرسل أيام الدوام مثل 1,3,5 ثم أرسل تم.', {});
      if (text === 'EDIT_TIMES') return this._guidedPrompt(phone, kind, 'START_TIME', 'وقت البداية؟ HH:mm', {});
      if (text === 'EDIT_DATE') return this._guidedPrompt(phone, kind, kind === 'TEMPORARY_CLOSE' ? 'START_DATE' : 'DATE', 'التاريخ؟ YYYY-MM-DD', {});
      if (text === 'CANCEL') return this._showMenu(phone, 'تم إلغاء العملية.');
      return this._showEditMenu(phone, draft);
    }
    if (kind === 'RECURRING') {
      if (draft.doctor_ux_step) {
        return this._handleRecurringGuided(controlContext, phone, text, draft);
      }
      return this._inputRecurring(controlContext, phone, text);
    }
    if (kind === 'TEMPORARY_CLOSE') {
      if (draft.doctor_ux_step) {
        return this._handleTemporaryCloseGuided(controlContext, phone, text, draft);
      }
      return this._inputTemporaryClose(controlContext, phone, text);
    }
    if (kind === 'TEMPORARY_OPEN') {
      return this._inputExceptionalOpen(controlContext, phone, text);
    }
    if (kind === 'CANCEL_CHANGE') {
      return this._inputCancelSelection(controlContext, phone, text);
    }
    return this._showMenu(phone);
  },

  _startRecurringGuided: function(phone) {
    var set = ConversationRepository.setDoctorControlUxSession(
      phone,
      Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT,
      { doctor_draft_kind: 'RECURRING', doctor_ux_step: 'DAYS', doctor_draft_days: '' }
    );
    if (!set.ok) return set;
    return Result.ok({
      reply: 'تغيير الجدول الأسبوعي:\nأرسل أرقام أيام الدوام مفصولة بفواصل، مثال: 1,3,5\n1=الأحد ... 7=السبت\nثم أرسل تم.',
      controlState: Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT,
      deliveryOptions: { fallbackToText: true }
    });
  },

  _startTemporaryCloseGuided: function(phone) {
    var set = ConversationRepository.setDoctorControlUxSession(
      phone,
      Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT,
      { doctor_draft_kind: 'TEMPORARY_CLOSE', doctor_ux_step: 'MODE', doctor_ux_close_mode: '' }
    );
    if (!set.ok) return set;
    return Result.ok({
      reply: 'إغلاق مؤقت: اختر يومًا كاملًا أو فترة محددة.',
      controlState: Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT,
      deliveryOptions: {
        interactiveButtons: [
          { id: 'TEMP_CLOSE_FULL_DAY', title: 'يوم كامل' },
          { id: 'TEMP_CLOSE_PERIOD', title: 'فترة محددة' },
          { id: 'CANCEL', title: 'رجوع' }
        ],
        fallbackToText: true
      }
    });
  },

  _guidedPrompt: function(phone, kind, step, reply, patch) {
    var fields = Object.assign({
      doctor_draft_kind: kind,
      doctor_ux_step: step
    }, patch || {});
    var set;
    if (step === 'MODE') {
      set = ConversationRepository.setDoctorControlUxSession(
        phone,
        Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT,
        fields
      );
    } else {
      set = ConversationRepository.updateDoctorControlUxSession(
        phone,
        Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT,
        fields
      );
    }
    if (!set.ok) return set;
    return Result.ok({
      reply: reply,
      controlState: Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT,
      deliveryOptions: {
        interactiveButtons: kind === 'TEMPORARY_CLOSE' && step === 'MODE'
          ? [
              { id: 'TEMP_CLOSE_FULL_DAY', title: 'يوم كامل' },
              { id: 'TEMP_CLOSE_PERIOD', title: 'فترة محددة' },
              { id: 'CANCEL', title: 'رجوع' }
            ]
          : undefined,
        fallbackToText: true
      }
    });
  },

  _handleRecurringGuided: function(controlContext, phone, text, draft) {
    // Legacy compound input remains accepted.
    if (text.indexOf('|') !== -1) return this._inputRecurring(controlContext, phone, text);
    if (draft.doctor_ux_step === 'DAYS') {
      if (text === 'DONE_DAYS' || text.toLowerCase() === 'تم') {
        if (!draft.doctor_draft_days) return this._guidedRetry(phone, draft, 'اختر يوم دوام واحدًا على الأقل.');
        return this._guidedPrompt(phone, 'RECURRING', 'START_TIME', 'وقت بداية الدوام؟ مثال: 10:00');
      }
      var parsed = this._parseDays(text);
      if (!parsed.ok) return this._guidedRetry(phone, draft, parsed.error.message);
      return this._guidedPrompt(
        phone, 'RECURRING', 'DAYS',
        'تم حفظ الأيام: ' + parsed.data.map(function(k) {
          return DoctorControlInteractionService.DAY_LABELS[EffectiveScheduleService.DAY_KEYS.indexOf(k)];
        }).join('، ') + '\nأرسل تم عند الاكتمال.',
        { doctor_draft_days: parsed.data.join(',') }
      );
    }
    if (draft.doctor_ux_step === 'START_TIME') {
      if (!/^\d{2}:\d{2}$/.test(text)) return this._guidedRetry(phone, draft, 'الوقت يجب أن يكون بصيغة HH:mm.');
      return this._guidedPrompt(phone, 'RECURRING', 'END_TIME', 'وقت نهاية الدوام؟ مثال: 14:00', { doctor_ux_start_time: text });
    }
    if (draft.doctor_ux_step === 'END_TIME') {
      if (!/^\d{2}:\d{2}$/.test(text)) return this._guidedRetry(phone, draft, 'الوقت يجب أن يكون بصيغة HH:mm.');
      return this._guidedPrompt(phone, 'RECURRING', 'DATE', 'تاريخ بدء التغيير؟ YYYY-MM-DD', {
        doctor_ux_end_time: text,
        doctor_draft_window: draft.doctor_ux_start_time + '-' + text
      });
    }
    if (draft.doctor_ux_step === 'DATE') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return this._guidedRetry(phone, draft, 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD.');
      return this._previewAndAsk(controlContext, phone, {
        doctor_draft_kind: 'RECURRING',
        doctor_draft_days: draft.doctor_draft_days,
        doctor_draft_window: draft.doctor_draft_window,
        doctor_draft_effective_from: text,
        doctor_draft_command_id: IdGenerator.generateScheduleCommandId()
      });
    }
    return this._showMenu(phone);
  },

  _handleTemporaryCloseGuided: function(controlContext, phone, text, draft) {
    if (text.indexOf('|') !== -1) return this._inputTemporaryClose(controlContext, phone, text);
    if (draft.doctor_ux_step === 'MODE') {
      if (text === 'TEMP_CLOSE_FULL_DAY') return this._guidedPrompt(phone, 'TEMPORARY_CLOSE', 'START_DATE', 'ما تاريخ الإغلاق؟ YYYY-MM-DD', { doctor_ux_close_mode: 'FULL_DAY' });
      if (text === 'TEMP_CLOSE_PERIOD') return this._guidedPrompt(phone, 'TEMPORARY_CLOSE', 'START_DATE', 'تاريخ بداية الإغلاق؟ YYYY-MM-DD', { doctor_ux_close_mode: 'PERIOD' });
      return this._guidedRetry(phone, draft, 'اختر يومًا كاملًا أو فترة محددة.');
    }
    if (draft.doctor_ux_step === 'START_DATE') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return this._guidedRetry(phone, draft, 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD.');
      if (draft.doctor_ux_close_mode === 'FULL_DAY') {
        var next = DateUtils.nextLocalDateString(text);
        if (!next) return this._guidedRetry(phone, draft, 'التاريخ غير صحيح.');
        return this._previewAndAsk(controlContext, phone, {
          doctor_draft_kind: 'TEMPORARY_CLOSE',
          doctor_draft_effective_from: text + 'T00:00',
          doctor_draft_effective_to: next + 'T00:00',
          doctor_draft_command_id: IdGenerator.generateScheduleCommandId()
        });
      }
      return this._guidedPrompt(phone, 'TEMPORARY_CLOSE', 'START_TIME', 'وقت بداية الإغلاق؟ HH:mm', { doctor_ux_start_date: text });
    }
    if (draft.doctor_ux_step === 'START_TIME') {
      if (!/^\d{2}:\d{2}$/.test(text)) return this._guidedRetry(phone, draft, 'الوقت يجب أن يكون بصيغة HH:mm.');
      return this._guidedPrompt(phone, 'TEMPORARY_CLOSE', 'END_DATE', 'تاريخ نهاية الإغلاق؟ YYYY-MM-DD', { doctor_ux_start_time: text });
    }
    if (draft.doctor_ux_step === 'END_DATE') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return this._guidedRetry(phone, draft, 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD.');
      return this._guidedPrompt(phone, 'TEMPORARY_CLOSE', 'END_TIME', 'وقت نهاية الإغلاق؟ HH:mm', { doctor_ux_end_date: text });
    }
    if (draft.doctor_ux_step === 'END_TIME') {
      if (!/^\d{2}:\d{2}$/.test(text)) return this._guidedRetry(phone, draft, 'الوقت يجب أن يكون بصيغة HH:mm.');
      var from = draft.doctor_ux_start_date + 'T' + draft.doctor_ux_start_time;
      var to = draft.doctor_ux_end_date + 'T' + text;
      if (to <= from) return this._guidedRetry(phone, draft, 'يجب أن تكون نهاية الإغلاق بعد بدايته.');
      return this._previewAndAsk(controlContext, phone, {
        doctor_draft_kind: 'TEMPORARY_CLOSE',
        doctor_draft_effective_from: from,
        doctor_draft_effective_to: to,
        doctor_draft_command_id: IdGenerator.generateScheduleCommandId()
      });
    }
    return this._showMenu(phone);
  },

  _guidedRetry: function(phone, draft, reason) {
    return this._guidedPrompt(phone, draft.doctor_draft_kind, draft.doctor_ux_step, reason, draft);
  },

  _showEditMenu: function(phone, draft) {
    var buttons = draft.doctor_draft_kind === 'RECURRING'
      ? [
          { id: 'EDIT_DAYS', title: 'الأيام' },
          { id: 'EDIT_TIMES', title: 'الأوقات' },
          { id: 'EDIT_DATE', title: 'تاريخ البدء' }
        ]
      : [
          { id: 'EDIT_DATE', title: 'التاريخ' },
          { id: 'EDIT_TIMES', title: 'الأوقات' },
          { id: 'CANCEL', title: 'إلغاء' }
        ];
    var set = ConversationRepository.setDoctorControlUxSession(
      phone,
      Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT,
      Object.assign({}, draft, { doctor_ux_step: 'EDIT' })
    );
    if (!set.ok) return set;
    return Result.ok({
      reply: 'اختر الحقل الذي تريد تعديله.',
      controlState: Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT,
      deliveryOptions: { interactiveButtons: buttons, fallbackToText: true }
    });
  },

  _inputRecurring: function(controlContext, phone, text) {
    var parts = text.split('|').map(function(p) { return p.trim(); });
    if (parts.length !== 3) {
      return this._retryInput(phone, 'RECURRING',
        'صيغة غير صحيحة. المطلوب: أيام | نافذة | تاريخ\nمثال: 1,2,4 | 10:00-14:00 | 2026-09-15');
    }
    var days = this._parseDays(parts[0]);
    if (!days.ok) return this._retryInput(phone, 'RECURRING', days.error.message);
    var window = this._parseWindow(parts[1]);
    if (!window.ok) return this._retryInput(phone, 'RECURRING', window.error.message);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parts[2])) {
      return this._retryInput(phone, 'RECURRING', 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD');
    }

    var draft = {
      doctor_draft_kind: 'RECURRING',
      doctor_draft_days: days.data.join(','),
      doctor_draft_window: window.data.start + '-' + window.data.end,
      doctor_draft_effective_from: parts[2],
      doctor_draft_command_id: IdGenerator.generateScheduleCommandId()
    };
    return this._previewAndAsk(controlContext, phone, draft);
  },

  _inputTemporaryClose: function(controlContext, phone, text) {
    var from = null;
    var to = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      var next = DateUtils.nextLocalDateString(text);
      if (!next) {
        return this._retryInput(phone, 'TEMPORARY_CLOSE', 'التاريخ غير صحيح.');
      }
      from = text + 'T00:00';
      to = next + 'T00:00';
    } else {
      var parts = text.split('|').map(function(p) { return p.trim(); });
      if (parts.length !== 2) {
        return this._retryInput(phone, 'TEMPORARY_CLOSE',
          'صيغة غير صحيحة. أرسل تاريخًا كاملًا أو: من | إلى\nمثال: 2026-09-20 10:00 | 2026-09-20 12:00');
      }
      var f = this._parseLocalDateTimeText(parts[0]);
      var t = this._parseLocalDateTimeText(parts[1]);
      if (!f || !t) {
        return this._retryInput(phone, 'TEMPORARY_CLOSE',
          'صيغة وقت غير صحيحة. مثال: 2026-09-20 10:00 | 2026-09-20 12:00');
      }
      from = f;
      to = t;
    }
    var draft = {
      doctor_draft_kind: 'TEMPORARY_CLOSE',
      doctor_draft_effective_from: from,
      doctor_draft_effective_to: to,
      doctor_draft_command_id: IdGenerator.generateScheduleCommandId()
    };
    return this._previewAndAsk(controlContext, phone, draft);
  },

  _inputExceptionalOpen: function(controlContext, phone, text) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return this._retryInput(phone, 'TEMPORARY_OPEN', 'أرسل التاريخ بصيغة YYYY-MM-DD فقط.');
    }
    var draft = {
      doctor_draft_kind: 'TEMPORARY_OPEN',
      doctor_draft_effective_from: text,
      doctor_draft_command_id: IdGenerator.generateScheduleCommandId()
    };
    return this._previewAndAsk(controlContext, phone, draft);
  },

  _promptCancelList: function(controlContext, phone) {
    var listResult = this._cancellableChanges(controlContext);
    if (!listResult.ok) return this._showMenu(phone, 'تعذر قراءة التغييرات: ' + listResult.error.code);
    var items = listResult.data;
    if (!items.length) {
      return this._showMenu(phone, 'لا توجد تغييرات قابلة للإلغاء حاليًا.');
    }
    var lines = ['اختر رقم التغيير الذي تريد إلغاءه:'];
    for (var i = 0; i < items.length; i++) {
      lines.push((i + 1) + ') ' + this._describeChange(items[i]));
    }
    lines.push('أرسل 0 للرجوع.');
    var set = ConversationRepository.setDoctorControlSession(
      phone,
      Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT,
      { doctor_draft_kind: 'CANCEL_CHANGE' }
    );
    if (!set.ok) return set;
    return Result.ok({
      reply: lines.join('\n'),
      controlState: Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT
    });
  },

  _inputCancelSelection: function(controlContext, phone, text) {
    if (!/^\d+$/.test(text)) {
      return this._retryInput(phone, 'CANCEL_CHANGE', 'أرسل رقم التغيير من القائمة، أو 0 للرجوع.');
    }
    var listResult = this._cancellableChanges(controlContext);
    if (!listResult.ok) return this._showMenu(phone, 'تعذر قراءة التغييرات: ' + listResult.error.code);
    var index = parseInt(text, 10) - 1;
    if (index < 0 || index >= listResult.data.length) {
      return this._retryInput(phone, 'CANCEL_CHANGE', 'رقم غير موجود في القائمة. أعد المحاولة أو أرسل 0 للرجوع.');
    }
    var target = listResult.data[index];
    var draft = {
      doctor_draft_kind: 'CANCEL_CHANGE',
      doctor_draft_target_change_id: target.changeId,
      doctor_draft_command_id: IdGenerator.generateScheduleCommandId()
    };
    return this._previewAndAsk(controlContext, phone, draft);
  },

  _retryInput: function(phone, kind, reason) {
    var set = ConversationRepository.setDoctorControlSession(
      phone,
      Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT,
      { doctor_draft_kind: kind }
    );
    if (!set.ok) return set;
    return Result.ok({
      reply: reason,
      controlState: Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_INPUT
    });
  },

  // ─────────────────────────────────────────────────────────
  // Preview (read-only) → Confirmation prompt
  // ─────────────────────────────────────────────────────────

  _previewAndAsk: function(controlContext, phone, draft) {
    var command = this._commandFromDraft(draft);
    if (!command.ok) return this._retryInput(phone, draft.doctor_draft_kind, command.error.message);

    var preview = this._runPreview(controlContext, draft.doctor_draft_kind, command.data);
    if (!preview.ok) {
      return this._retryInput(
        phone,
        draft.doctor_draft_kind,
        'لا يمكن تنفيذ هذا التغيير: ' + preview.error.code +
          (preview.error.message ? '\n' + preview.error.message : '') +
          '\nأعد المحاولة أو أرسل 0 للرجوع.'
      );
    }
    if (preview.data.status === 'ALREADY_COMMITTED') {
      return this._showMenu(phone, 'هذا الأمر منفذ سابقًا (نفس commandId).');
    }

    var impact = this._countAffectedBookings(controlContext, preview.data, command.data.asOf);
    if (!impact.ok) return impact;

    var set = ConversationRepository.setDoctorControlSession(
      phone,
      Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_CONFIRMATION,
      draft
    );
    if (!set.ok) return set;

    var record = preview.data.record;
    var lines = [
      'معاينة (لم يُحفظ شيء بعد):',
      'النوع: ' + this.KIND_LABELS[draft.doctor_draft_kind],
      'يسري من: ' + record.effectiveFrom +
        (record.effectiveTo ? ' حتى ' + record.effectiveTo + ' (النهاية غير مشمولة)' : ''),
      'الحجوزات المتأثرة حاليًا: ' + impact.data.count,
      '',
      'أرسل 1 للتأكيد أو 2 للإلغاء.'
    ];
    return Result.ok({
      reply: lines.join('\n'),
      controlState: Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_CONFIRMATION,
      deliveryOptions: {
        interactiveButtons: [
          { id: 'CONFIRM', title: 'تأكيد' },
          { id: 'EDIT', title: 'تعديل' },
          { id: 'CANCEL', title: 'إلغاء' }
        ],
        fallbackToText: true
      }
    });
  },

  _handleConfirmation: function(controlContext, phone, text, draft) {
    if (text === '2' || text === '0' || text === 'CANCEL') {
      return this._showMenu(phone, 'تم إلغاء العملية. لم يُحفظ أي تغيير.');
    }
    if (text === 'EDIT') {
      return this._showEditMenu(phone, draft);
    }
    if (text !== '1' && text !== 'CONFIRM') {
      return Result.ok({
        reply: 'أرسل 1 للتأكيد أو 2 للإلغاء.',
        controlState: Config.VOCABULARY.CONVERSATION_STATE.DOCTOR_AWAITING_CONFIRMATION,
        deliveryOptions: {
          interactiveButtons: [
            { id: 'CONFIRM', title: 'تأكيد' },
            { id: 'CANCEL', title: 'إلغاء' }
          ],
          fallbackToText: true
        }
      });
    }

    var command = this._commandFromDraft(draft);
    if (!command.ok) return this._showMenu(phone, 'تعذر إكمال العملية: ' + command.error.message);

    var commit = this._runCommit(controlContext, draft.doctor_draft_kind, command.data);
    if (!commit.ok) {
      return this._showMenu(
        phone,
        'فشل التنفيذ: ' + commit.error.code +
          (commit.error.message ? '\n' + commit.error.message : '')
      );
    }
    var record = commit.data.record;
    var status = commit.data.status === 'IDEMPOTENT_REPLAY'
      ? 'هذا الأمر كان منفذًا سابقًا — لم يُنشأ سجل مكرر.'
      : 'تم تنفيذ التغيير وحفظه.';
    return this._showMenu(
      phone,
      status + '\nالمرجع: ' + record.changeId +
        '\nيسري من: ' + record.effectiveFrom +
        (record.effectiveTo ? ' حتى ' + record.effectiveTo : '')
    );
  },

  // ─────────────────────────────────────────────────────────
  // Semantic command construction (numbers never reach here)
  // ─────────────────────────────────────────────────────────

  _commandFromDraft: function(draft) {
    var asOf = DateUtils.formatLocalStamp(Clock.now());
    var kind = draft.doctor_draft_kind;
    var commandId = draft.doctor_draft_command_id;
    if (!commandId) {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'Draft is missing its commandId');
    }

    if (kind === 'RECURRING') {
      var dayKeys = (draft.doctor_draft_days || '').split(',');
      var days = {};
      var keys = EffectiveScheduleService.DAY_KEYS;
      for (var i = 0; i < keys.length; i++) days[keys[i]] = false;
      for (var j = 0; j < dayKeys.length; j++) {
        if (keys.indexOf(dayKeys[j]) === -1) {
          return Result.fail('INVALID_SCHEDULE_COMMAND', 'Draft day key is invalid: ' + dayKeys[j]);
        }
        days[dayKeys[j]] = true;
      }
      var windowParts = (draft.doctor_draft_window || '').split('-');
      if (windowParts.length !== 2) {
        return Result.fail('INVALID_SCHEDULE_COMMAND', 'Draft work window is invalid');
      }
      return Result.ok({
        commandId: commandId,
        asOf: asOf,
        effectiveDate: draft.doctor_draft_effective_from,
        schedule: {
          days: days,
          workWindow: { start: windowParts[0], end: windowParts[1] }
        }
      });
    }
    if (kind === 'TEMPORARY_CLOSE') {
      return Result.ok({
        commandId: commandId,
        asOf: asOf,
        effectiveFrom: draft.doctor_draft_effective_from,
        effectiveTo: draft.doctor_draft_effective_to
      });
    }
    if (kind === 'TEMPORARY_OPEN') {
      return Result.ok({
        commandId: commandId,
        asOf: asOf,
        date: draft.doctor_draft_effective_from
      });
    }
    if (kind === 'CANCEL_CHANGE') {
      return Result.ok({
        commandId: commandId,
        asOf: asOf,
        targetChangeId: draft.doctor_draft_target_change_id
      });
    }
    return Result.fail('INVALID_SCHEDULE_COMMAND', 'Unknown draft kind: ' + kind);
  },

  _runPreview: function(controlContext, kind, command) {
    if (kind === 'RECURRING') return DoctorScheduleCommandService.previewRecurringChange(controlContext, command);
    if (kind === 'TEMPORARY_CLOSE') return DoctorScheduleCommandService.previewTemporaryClose(controlContext, command);
    if (kind === 'TEMPORARY_OPEN') return DoctorScheduleCommandService.previewExceptionalOpen(controlContext, command);
    if (kind === 'CANCEL_CHANGE') return DoctorScheduleCommandService.previewCancelChange(controlContext, command);
    return Result.fail('INVALID_SCHEDULE_COMMAND', 'Unknown command kind: ' + kind);
  },

  _runCommit: function(controlContext, kind, command) {
    if (kind === 'RECURRING') return DoctorScheduleCommandService.commitRecurringChange(controlContext, command);
    if (kind === 'TEMPORARY_CLOSE') return DoctorScheduleCommandService.commitTemporaryClose(controlContext, command);
    if (kind === 'TEMPORARY_OPEN') return DoctorScheduleCommandService.commitExceptionalOpen(controlContext, command);
    if (kind === 'CANCEL_CHANGE') return DoctorScheduleCommandService.cancelChange(controlContext, command);
    return Result.fail('INVALID_SCHEDULE_COMMAND', 'Unknown command kind: ' + kind);
  },

  // ─────────────────────────────────────────────────────────
  // Impact count — READ ONLY (contract §11.2: count, no details)
  // ─────────────────────────────────────────────────────────

  _countAffectedBookings: function(controlContext, previewData, asOfStamp) {
    var scope = {
      doctorId: controlContext.actorId,
      clinicId: controlContext.scope && controlContext.scope.clinicId !== undefined
        ? controlContext.scope.clinicId
        : null
    };
    var proposed = Object.assign({}, previewData.record, {
      changeId: 'PREVIEW_CANDIDATE',
      createdAt: '',
      status: 'COMMITTED'
    });
    var baseline = previewData.baseline;
    var records = previewData.records;

    var slotsResult = SlotRepository.queryResult(function(row) {
      return row.status === Config.VOCABULARY.STATUS.RESERVED ||
        row.status === Config.VOCABULARY.STATUS.CONFIRMED;
    });
    if (!slotsResult.ok) return slotsResult;

    var count = 0;
    var slots = slotsResult.data;
    for (var i = 0; i < slots.length; i++) {
      var stamp = this._sortKeyToStamp(slots[i].sort_key);
      if (!stamp) continue; // unparseable legacy sort_key — best-effort read
      if (EffectiveScheduleService.compareStamps(stamp, asOfStamp) < 0) continue; // past

      var at = EffectiveScheduleService.parseLocalDateTime(stamp);
      if (!at.ok) continue;

      var current = EffectiveScheduleService.projectFromSources(scope, at.data, baseline, records);
      if (!current.ok) return current;
      var hypothetical = EffectiveScheduleService.projectFromSources(
        scope,
        at.data,
        baseline,
        records.concat([proposed])
      );
      if (!hypothetical.ok) return hypothetical;

      if (current.data.interval.intent !== 'CLOSED' &&
          hypothetical.data.interval.intent === 'CLOSED') {
        count += 1;
      }
    }
    return Result.ok({ count: count });
  },

  /**
   * 'YYYYMMDDHHmm' sort_key → 'YYYY-MM-DDTHH:mm' local stamp.
   * Pure string projection; unparseable legacy keys return null
   * (best-effort read, consistent with SlotSelection).
   */
  _sortKeyToStamp: function(sortKey) {
    var s = String(sortKey == null ? '' : sortKey).trim();
    if (!/^\d{12}$/.test(s)) return null;
    return s.substring(0, 4) + '-' + s.substring(4, 6) + '-' + s.substring(6, 8) +
      'T' + s.substring(8, 10) + ':' + s.substring(10, 12);
  },

  // ─────────────────────────────────────────────────────────
  // Cancellable changes read model
  // ─────────────────────────────────────────────────────────

  _cancellableChanges: function(controlContext) {
    var scope = {
      doctorId: controlContext.actorId,
      clinicId: controlContext.scope && controlContext.scope.clinicId !== undefined
        ? controlContext.scope.clinicId
        : null
    };
    var asOf = DateUtils.formatLocalStamp(Clock.now());
    var listResult = ScheduleChangeRepository.listByScopeResult(scope.doctorId, scope.clinicId);
    if (!listResult.ok) return listResult;
    var activeResult = EffectiveScheduleService._activeRecords(listResult.data, asOf);
    if (!activeResult.ok) return activeResult;
    var relevant = activeResult.data.filter(function(rec) {
      if (rec.effectiveTo) {
        return EffectiveScheduleService.compareStamps(asOf, rec.effectiveTo) < 0;
      }
      return true; // recurring without end stays cancellable
    });
    relevant.sort(function(a, b) {
      if (a.effectiveFrom !== b.effectiveFrom) {
        return a.effectiveFrom < b.effectiveFrom ? -1 : 1;
      }
      return a.changeId < b.changeId ? -1 : 1;
    });
    return Result.ok(relevant);
  },

  _describeChange: function(rec) {
    var kindLabel = rec.changeKind === ScheduleChangeRepository.KIND.RECURRING
      ? this.KIND_LABELS.RECURRING
      : rec.changeKind === ScheduleChangeRepository.KIND.TEMPORARY_CLOSE
        ? this.KIND_LABELS.TEMPORARY_CLOSE
        : this.KIND_LABELS.TEMPORARY_OPEN;
    return kindLabel + ' — من ' + rec.effectiveFrom +
      (rec.effectiveTo ? ' حتى ' + rec.effectiveTo : '');
  },

  // ─────────────────────────────────────────────────────────
  // Presentation parsing helpers (channel representation only)
  // ─────────────────────────────────────────────────────────

  _parseDays: function(text) {
    var tokens = text.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t !== ''; });
    if (!tokens.length) {
      return Result.fail('INVALID_INPUT', 'حدد يوم دوام واحدًا على الأقل (1=الأحد ... 7=السبت).');
    }
    var keys = [];
    for (var i = 0; i < tokens.length; i++) {
      if (!/^[1-7]$/.test(tokens[i])) {
        return Result.fail('INVALID_INPUT', 'الأيام أرقام من 1 إلى 7 مفصولة بفواصل (1=الأحد ... 7=السبت).');
      }
      var key = EffectiveScheduleService.DAY_KEYS[parseInt(tokens[i], 10) - 1];
      if (keys.indexOf(key) === -1) keys.push(key);
    }
    return Result.ok(keys);
  },

  _parseWindow: function(text) {
    var parts = text.split('-').map(function(p) { return p.trim(); });
    if (parts.length !== 2 || !/^\d{1,2}:\d{2}$/.test(parts[0]) || !/^\d{1,2}:\d{2}$/.test(parts[1])) {
      return Result.fail('INVALID_INPUT', 'النافذة بصيغة HH:mm-HH:mm، مثال: 10:00-14:00');
    }
    return Result.ok({ start: parts[0], end: parts[1] });
  },

  _parseLocalDateTimeText: function(text) {
    var m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(text.trim());
    if (!m) return null;
    return m[1] + 'T' + m[2];
  }
};
