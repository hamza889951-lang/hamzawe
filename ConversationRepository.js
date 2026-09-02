/**
 * ═══════════════════════════════════════
 * CONTRACT — ConversationRepository
 * ═══════════════════════════════════════
 * يضمن:
 * - إيجاد محادثة، وبدء محادثة جديدة، والانتقال بين حالاتها عبر عمليات
 *   محددة الاسم والمعنى (startNew, moveToWaitingName...) بحيث لا يحتاج
 *   المستدعي معرفة أسماء الحقول الداخلية (temp_name, slot_id, updated_at).
 * لا يضمن:
 * - صحة انتقال الحالة — StateMachine الخاصة بالمحادثة (إن وُجدت مستقبلاً)
 *   ليست هنا ولا حاجة لها في v1.
 *
 * ── تعديل بقرار مراجعة معمارية من المشرف ──
 * سابقاً كان BookingService يبني كائن الحقول بنفسه (temp_name, slot_id,
 * updated_at) ويمرره لـ updateState() العامة. هذا كان يخالف CAS-003
 * لأن أي تغيير في بنية ورقة Conversations كان سيفرض تعديل BookingService.
 * الآن BookingService يطلب "انتقل إلى WAITING_NAME" فقط، ولا يعرف كيف
 * يُخزَّن ذلك فعلياً.
 */
const ConversationRepository = {

  findByPhone(phone) {
    return GoogleSheets.findRowByColumn(
      Config.VOCABULARY.SHEETS.CONVERSATIONS, 'phone', phone
    );
  },

  /** @returns {Object} السجل المُنشأ */
  startNew(phone) {
    const record = {
      conversation_id: IdGenerator.generateConversationId(),
      phone: phone,
      state: Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN,
      temp_name: '',
      slot_id: '',
      updated_at: Clock.now()
    };
    GoogleSheets.appendRow(Config.VOCABULARY.SHEETS.CONVERSATIONS, record);
    return record;
  },

  moveToWaitingName(phone) {
    this._updateState(phone, Config.VOCABULARY.CONVERSATION_STATE.WAITING_NAME, {});
  },

  /**
   * @param {string} phone
   * @param {string} patientName
   * @param {string} slotId
   */
  moveToWaitingConfirmation(phone, patientName, slotId) {
    this._updateState(phone, Config.VOCABULARY.CONVERSATION_STATE.WAITING_CONFIRMATION, {
      temp_name: patientName,
      slot_id: slotId
    });
  },

  moveToBooked(phone) {
    this._updateState(phone, Config.VOCABULARY.CONVERSATION_STATE.BOOKED, {});
  },

  /** إعادة ضبط كاملة عند حدوث خطأ أو حالة غير معروفة */
  resetToMenuMain(phone) {
    this._updateState(phone, Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN, {
      temp_name: '',
      slot_id: ''
    });
  },

  /**
   * دالة داخلية عامة — لا تُستدعى من خارج هذا الملف (راجع Checklist في
   * GoogleSheets.gs بخصوص دوال "_").
   */
  _updateState(phone, newState, extraFields) {
    const fields = Object.assign(
      { state: newState, updated_at: Clock.now() },
      extraFields || {}
    );
    GoogleSheets.updateRowByColumn(
      Config.VOCABULARY.SHEETS.CONVERSATIONS, 'phone', phone, fields
    );
  },

  // ═══════════════════════════════════════════════════════════
  // M4-C Continuation — Doctor Control session (bounded schema)
  // ═══════════════════════════════════════════════════════════
  // قرار المالك: إعادة استخدام Conversations دون repository جديد،
  // مع schema صريح ومحدود — لا JSON blob عام. الحقول أدناه هي كامل
  // مساحة الـdraft المسموح بها؛ أي مفتاح خارجها يُرفض.
  //
  // متطلب نشر: أعمدة DOCTOR_SESSION_FIELDS يجب إضافتها يدويًا إلى
  // ورقة Conversations قبل تفعيل Doctor Control. الدوال أدناه
  // fail-closed عند غياب الأعمدة (لأن البنية التحتية تتجاهل الحقول
  // المجهولة بصمت — raw updateRowByColumn يسقطها).

  DOCTOR_SESSION_FIELDS: [
    'doctor_draft_kind',             // RECURRING | TEMPORARY_CLOSE | TEMPORARY_OPEN | CANCEL_CHANGE
    'doctor_draft_days',             // CSV of semantic day keys (recurring only)
    'doctor_draft_window',           // 'HH:mm-HH:mm' (recurring only)
    'doctor_draft_effective_from',   // 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm'
    'doctor_draft_effective_to',     // 'YYYY-MM-DDTHH:mm' (temporary close only)
    'doctor_draft_target_change_id', // cancel only
    'doctor_draft_command_id'        // idempotency identity for preview→commit
  ],

  DOCTOR_STATES: [
    'DOCTOR_MENU',
    'DOCTOR_AWAITING_INPUT',
    'DOCTOR_AWAITING_CONFIRMATION'
  ],

  /**
   * @param {string} phone — normalized doctor phone (actorId)
   * @returns {Result} ok({ exists, state, draft }) | fail(...)
   */
  getDoctorControlSession(phone) {
    const schemaCheck = this._doctorSchemaCheck();
    if (!schemaCheck.ok) return schemaCheck;
    try {
      const row = this.findByPhone(phone);
      if (!row) {
        return Result.ok({ exists: false, state: null, draft: {} });
      }
      const draft = {};
      this.DOCTOR_SESSION_FIELDS.forEach(function(field) {
        const value = row[field];
        draft[field] = value === undefined || value === null ? '' : String(value);
      });
      return Result.ok({ exists: true, state: row.state, draft: draft });
    } catch (e) {
      return Result.fail('DOCTOR_SESSION_READ_FAILED', e.message, e.stack);
    }
  },

  /**
   * يكتب حالة جلسة الطبيب + الـdraft كاملًا (الحقول غير المذكورة تُصفّر
   * — لا بقايا draft قديمة). fail-closed على state أو مفتاح غير معروف.
   * @param {string} phone
   * @param {string} doctorState — أحد DOCTOR_STATES
   * @param {Object} draft — subset of DOCTOR_SESSION_FIELDS
   * @returns {Result}
   */
  setDoctorControlSession(phone, doctorState, draft) {
    if (this.DOCTOR_STATES.indexOf(doctorState) === -1) {
      return Result.fail(
        'INVALID_DOCTOR_SESSION_STATE',
        'Unknown doctor control state: ' + doctorState
      );
    }
    const input = draft || {};
    const unknown = Object.keys(input).filter(function(key) {
      return ConversationRepository.DOCTOR_SESSION_FIELDS.indexOf(key) === -1;
    });
    if (unknown.length) {
      return Result.fail(
        'INVALID_DOCTOR_SESSION_FIELD',
        'Doctor draft fields outside the bounded schema: ' + unknown.join(', ')
      );
    }
    const schemaCheck = this._doctorSchemaCheck();
    if (!schemaCheck.ok) return schemaCheck;

    const fields = {};
    this.DOCTOR_SESSION_FIELDS.forEach(function(field) {
      const value = input[field];
      fields[field] = value === undefined || value === null ? '' : String(value);
    });

    try {
      const existing = this.findByPhone(phone);
      if (!existing) {
        const record = Object.assign({
          conversation_id: IdGenerator.generateConversationId(),
          phone: phone,
          state: doctorState,
          temp_name: '',
          slot_id: '',
          updated_at: Clock.now()
        }, fields);
        GoogleSheets.appendRow(Config.VOCABULARY.SHEETS.CONVERSATIONS, record);
        return Result.ok(record);
      }
      this._updateState(phone, doctorState, fields);
      return Result.ok(Object.assign({ phone: phone, state: doctorState }, fields));
    } catch (e) {
      return Result.fail('DOCTOR_SESSION_WRITE_FAILED', e.message, e.stack);
    }
  },

  /**
   * fail-closed schema presence check — the raw infrastructure silently
   * drops unknown columns, which would corrupt the preview→commit flow.
   */
  _doctorSchemaCheck() {
    try {
      const headers = GoogleSheets.getHeaders(Config.VOCABULARY.SHEETS.CONVERSATIONS);
      const missing = this.DOCTOR_SESSION_FIELDS.filter(function(field) {
        return headers.indexOf(field) === -1;
      });
      if (missing.length) {
        return Result.fail(
          'DOCTOR_CONTROL_SCHEMA_MISSING',
          'Conversations sheet is missing doctor session columns: ' + missing.join(', ')
        );
      }
      return Result.ok(true);
    } catch (e) {
      return Result.fail('DOCTOR_SESSION_READ_FAILED', e.message, e.stack);
    }
  }
};