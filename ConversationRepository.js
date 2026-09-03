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
  },

  // ═══════════════════════════════════════════════════════════
  // M4-F — Patient Disruption proposal session (bounded schema)
  // ═══════════════════════════════════════════════════════════
  // Same design contract as the doctor session above: the Conversations sheet
  // is reused, the field set is explicit and closed, and the repository FAILS
  // CLOSED when the required columns are absent — because the infrastructure
  // silently drops unknown columns, a raw updateRowByColumn would otherwise
  // persist a proposal that can never be read back.
  //
  // No generic JSON blob, no transcript, no raw Calendar identifier, no
  // unbounded metadata. The proposal is self-contained so a later inbound
  // message can resume the flow without reconstructing state from logs.
  //
  // Deployment prerequisite: the owner must provision these columns in the
  // Conversations sheet before operational activation. No automatic
  // production migration is part of M4-F (Closure Addendum §9).

  DISRUPTION_FIELDS: [
    'disruption_original_slot_id',
    'disruption_proposal_slot_id',
    'disruption_kind',
    'disruption_created_at_ms',
    'disruption_expires_at_ms',
    'disruption_proposal_id',
    'disruption_notification_status'
  ],

  DISRUPTION_KINDS: ['CONFIRMED', 'RESERVED'],

  DISRUPTION_NOTIFICATION_STATUSES: ['PENDING', 'SENT', 'FAILED'],

  /** Ordinary patient states a cleared disruption interaction may return to. */
  DISRUPTION_CLEAR_STATES: [
    Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN,
    Config.VOCABULARY.CONVERSATION_STATE.WAITING_NAME,
    Config.VOCABULARY.CONVERSATION_STATE.WAITING_CONFIRMATION,
    Config.VOCABULARY.CONVERSATION_STATE.BOOKED
  ],

  /** @returns {boolean} */
  isDisruptionState: function(state) {
    return state === Config.VOCABULARY.CONVERSATION_STATE.WAITING_DISRUPTION_CONFIRMATION;
  },

  /**
   * @param {string} phone — normalized phone
   * @returns {Result} ok({ exists, state, pending, proposal }) | fail(...)
   */
  getDisruptionSession: function(phone) {
    const schemaCheck = this._disruptionSchemaCheck();
    if (!schemaCheck.ok) return schemaCheck;
    try {
      const row = this.findByPhone(phone);
      if (!row) {
        return Result.ok({ exists: false, state: null, pending: false, proposal: null });
      }
      const proposal = {};
      this.DISRUPTION_FIELDS.forEach(function(field) {
        const value = row[field];
        proposal[field] = value === undefined || value === null ? '' : String(value);
      });
      const pending = this.isDisruptionState(row.state) &&
        proposal.disruption_proposal_id !== '';
      return Result.ok({
        exists: true,
        state: row.state,
        pending: pending,
        proposal: proposal
      });
    } catch (e) {
      return Result.fail('DISRUPTION_SESSION_READ_FAILED', e.message, e.stack);
    }
  },

  /**
   * Writes the full bounded proposal — unspecified fields are blanked so no
   * residue of a previous proposal survives — and moves the conversation to
   * WAITING_DISRUPTION_CONFIRMATION.
   *
   * @param {string} phone
   * @param {Object} proposal — subset of DISRUPTION_FIELDS
   * @returns {Result}
   */
  setDisruptionSession: function(phone, proposal) {
    const input = proposal || {};
    const unknown = Object.keys(input).filter(function(key) {
      return ConversationRepository.DISRUPTION_FIELDS.indexOf(key) === -1;
    });
    if (unknown.length) {
      return Result.fail(
        'INVALID_DISRUPTION_FIELD',
        'Disruption proposal fields outside the bounded schema: ' + unknown.join(', ')
      );
    }
    if (this.DISRUPTION_KINDS.indexOf(input.disruption_kind) === -1) {
      return Result.fail(
        'INVALID_DISRUPTION_KIND',
        'Unknown disruption kind: ' + String(input.disruption_kind)
      );
    }
    if (this.DISRUPTION_NOTIFICATION_STATUSES.indexOf(input.disruption_notification_status) === -1) {
      return Result.fail(
        'INVALID_DISRUPTION_NOTIFICATION_STATUS',
        'Unknown disruption notification status: ' + String(input.disruption_notification_status)
      );
    }
    if (!input.disruption_proposal_id) {
      return Result.fail(
        'INVALID_DISRUPTION_PROPOSAL',
        'A disruption proposal requires a durable proposal identity'
      );
    }

    const schemaCheck = this._disruptionSchemaCheck();
    if (!schemaCheck.ok) return schemaCheck;

    const fields = {};
    this.DISRUPTION_FIELDS.forEach(function(field) {
      const value = input[field];
      fields[field] = value === undefined || value === null ? '' : String(value);
    });

    const nextState = Config.VOCABULARY.CONVERSATION_STATE.WAITING_DISRUPTION_CONFIRMATION;
    try {
      const existing = this.findByPhone(phone);
      if (!existing) {
        const record = Object.assign({
          conversation_id: IdGenerator.generateConversationId(),
          phone: phone,
          state: nextState,
          temp_name: '',
          slot_id: '',
          updated_at: Clock.now()
        }, fields);
        GoogleSheets.appendRow(Config.VOCABULARY.SHEETS.CONVERSATIONS, record);
        return Result.ok(Object.assign({ phone: phone, state: nextState }, fields));
      }
      this._updateState(phone, nextState, fields);
      return Result.ok(Object.assign({ phone: phone, state: nextState }, fields));
    } catch (e) {
      return Result.fail('M4F_PROPOSAL_PERSIST_FAILED', e.message, e.stack);
    }
  },

  /**
   * Clears the bounded disruption fields and returns the conversation to an
   * ordinary patient state. Called only after the final outcome is durable
   * (confirmation confirmed) or after the proposal target has been released.
   *
   * @param {string} phone
   * @param {string} nextState — one of DISRUPTION_CLEAR_STATES
   * @returns {Result}
   */
  clearDisruptionSession: function(phone, nextState) {
    if (this.DISRUPTION_CLEAR_STATES.indexOf(nextState) === -1) {
      return Result.fail(
        'INVALID_DISRUPTION_CLEAR_STATE',
        'Disruption may only be cleared to an ordinary patient state: ' + String(nextState)
      );
    }
    const schemaCheck = this._disruptionSchemaCheck();
    if (!schemaCheck.ok) return schemaCheck;

    const fields = {};
    this.DISRUPTION_FIELDS.forEach(function(field) {
      fields[field] = '';
    });
    try {
      this._updateState(phone, nextState, fields);
      return Result.ok({ phone: phone, state: nextState, cleared: true });
    } catch (e) {
      return Result.fail('DISRUPTION_SESSION_WRITE_FAILED', e.message, e.stack);
    }
  },

  /**
   * Sweep used by the Scheduler to expire proposals whose window elapsed
   * while the patient never replied.
   *
   * @param {string} state
   * @returns {Result} ok(rows[]) | fail(...)
   */
  findConversationsByState: function(state) {
    const schemaCheck = this._disruptionSchemaCheck();
    if (!schemaCheck.ok) return schemaCheck;
    try {
      const rows = GoogleSheets.queryRows(
        Config.VOCABULARY.SHEETS.CONVERSATIONS,
        function(row) { return row.state === state; }
      );
      return Result.ok(rows);
    } catch (e) {
      return Result.fail('DISRUPTION_SESSION_READ_FAILED', e.message, e.stack);
    }
  },

  /**
   * fail-closed schema presence check. The raw infrastructure silently drops
   * unknown columns, which would make a persisted proposal unreadable and
   * would silently degrade every M4-F guarantee.
   */
  _disruptionSchemaCheck: function() {
    try {
      const headers = GoogleSheets.getHeaders(Config.VOCABULARY.SHEETS.CONVERSATIONS);
      const missing = this.DISRUPTION_FIELDS.filter(function(field) {
        return headers.indexOf(field) === -1;
      });
      if (missing.length) {
        return Result.fail(
          'M4F_SCHEMA_MISSING',
          'Conversations sheet is missing M4-F disruption columns: ' + missing.join(', ')
        );
      }
      return Result.ok(true);
    } catch (e) {
      return Result.fail('DISRUPTION_SESSION_READ_FAILED', e.message, e.stack);
    }
  }
};