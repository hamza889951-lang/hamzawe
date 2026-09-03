/**
 * ═══════════════════════════════════════
 * CONTRACT — AffectedAppointmentDiscoveryService (M4-E)
 * ═══════════════════════════════════════
 * HAMZAWE M4-E — Affected Appointment Discovery / Impact Preview.
 * Frozen M4-E session contract (2026-09-02), built on the M4-D materialized
 * Availability truth and the M4-C Continuation reuse rules.
 *
 * M4-E is an OBSERVATION LAYER. It is not a schedule engine, materializer,
 * lifecycle engine, selector, Calendar service, notification engine, patient
 * disruption engine, scheduler, or durable impact database.
 *
 * GUARANTEES
 * - Read-only. Exactly one bounded source read through
 *   SlotRepository.queryResult (Result-based: a storage failure stays a
 *   failure and is never collapsed into an empty impact set).
 * - Affectedness evidence is ONLY: is_available operationally false
 *   (canonical SlotRepository.isOperationallyAvailable check) inside the
 *   caller's explicit half-open operational window [from, to).
 * - Actionable classes:
 *     CONFIRMED && unavailable
 *     RESERVED  && unavailable && reserved_until_unix > evaluatedAtMs
 * - Excluded: FREE, terminal statuses, expired reservations.
 *   Malformed rows (sort_key / reservation expiry) are isolated, reported in
 *   diagnostics with evidence, excluded from actionable output — never
 *   silently discarded.
 * - Ordering: all affected CONFIRMED first, then affected RESERVED; within
 *   each class appointment start ascending (sort_key → LegacySlotTimeParser),
 *   then slot_id ascending. Storage row order never matters.
 * - Clock.now() is captured exactly once per operation (evaluatedAt).
 * - Default DTO carries NO patient PII: no patient name, phone, raw calendar
 *   event id, or conversation data. M4-F re-reads the current Slot at action
 *   time.
 * - completeness is always CURRENT_MATERIALIZED_VIEW — evidence about the
 *   current materialized view, never an exhaustive historical impact claim.
 * - Deterministic: unchanged source rows ⇒ same membership, same class
 *   ordering, same within-class ordering, same diagnostics semantics.
 *   No random identifiers. No durable journal — M4-E is repeatable
 *   observation; action idempotency belongs to M4-F / the mutation boundary.
 * - Not a transaction snapshot: an item can become stale immediately; the
 *   output is evidence, not mutation authority. No locks are taken.
 *
 * FIXED REASON SEMANTICS (no causal changeId provenance is ever claimed)
 *   impactReason       = OPERATIONALLY_UNAVAILABLE
 *   impactReasonSource = SLOT_IS_AVAILABLE
 *
 * HARD BOUNDARIES (this file performs no writes of any kind and contains)
 * - no row mutation path of any repository;
 * - no Calendar, conversation, notification, or schedule-record access;
 * - no EffectiveSchedule recomputation, no Settings/ScheduleChange reads;
 * - no selection policy, state machine, scheduler, lock, or second store;
 * - no multi-clinic behavior (scope is preserved as logical metadata only —
 *   the v1 Availability schema does not physically partition rows by scope).
 *
 * DEPENDENCIES (Application layer, per CAS)
 *   Result, Config, Clock, SlotRepository.queryResult,
 *   SlotRepository.isOperationallyAvailable, LegacySlotTimeParser
 */
const AffectedAppointmentDiscoveryService = {

  IMPACT_REASON: 'OPERATIONALLY_UNAVAILABLE',
  IMPACT_REASON_SOURCE: 'SLOT_IS_AVAILABLE',
  COMPLETENESS: 'CURRENT_MATERIALIZED_VIEW',

  /**
   * Discovers affected appointments in the current materialized Availability.
   *
   * @param {Object} request
   * @param {Date|number} request.from  inclusive window start (Date or epoch ms)
   * @param {Date|number} request.to    exclusive window end (Date or epoch ms)
   * @param {Object} [request.scope]    optional logical scope { doctorId, clinicId }
   * @returns {Result}
   *   ok   ⇒ ImpactDiscoveryResult:
   *          { sourceStatus, evaluatedAt, evaluatedAtMs, scope, window,
   *            completeness, affected, affectedConfirmed, affectedReserved,
   *            counts: { confirmed, reserved, total, malformed },
   *            diagnostics }
   *   fail ⇒ INVALID_DISCOVERY_WINDOW | INVALID_DISCOVERY_SCOPE |
   *          AVAILABILITY_SOURCE_FAILED
   */
  discoverAffected: function(request) {
    // Evaluation instant captured exactly once for the whole operation.
    var evaluatedAt = Clock.now();
    var evaluatedAtMs = evaluatedAt.getTime();

    var req = (request !== null && typeof request === 'object') ? request : {};

    var fromMs = AffectedAppointmentDiscoveryService._toEpochMs(req.from);
    var toMs = AffectedAppointmentDiscoveryService._toEpochMs(req.to);
    if (fromMs === null || toMs === null || fromMs >= toMs) {
      return Result.fail(
        'INVALID_DISCOVERY_WINDOW',
        'M4-E discovery requires an explicit half-open window [from, to) with from < to',
        { from: String(req.from), to: String(req.to) }
      );
    }

    var scopeResult = AffectedAppointmentDiscoveryService._normalizeScope(req.scope);
    if (!scopeResult.ok) return scopeResult;
    var scope = scopeResult.data;

    // Single bounded source read through the Result-based repository API.
    // The predicate is a coarse candidate filter only (actionable statuses +
    // operationally unavailable); exact window membership and classification
    // happen below so malformed rows stay visible and reportable instead of
    // being silently dropped by the predicate.
    var sourceResult = SlotRepository.queryResult(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.CONFIRMED &&
          row.status !== Config.VOCABULARY.STATUS.RESERVED) {
        return false; // FREE and terminal rows are never affected appointments
      }
      return !SlotRepository.isOperationallyAvailable(row.is_available);
    });

    if (!sourceResult.ok) {
      // Source-level failure is never collapsed into an empty impact set.
      return Result.fail(
        'AVAILABILITY_SOURCE_FAILED',
        'Availability source read failed; impact discovery cannot report an impact set',
        { cause: sourceResult.error }
      );
    }

    var rows = sourceResult.data;
    var confirmed = [];
    var reserved = [];
    var diagnostics = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];

      // Chronological truth is sort_key → LegacySlotTimeParser only.
      // No fallback to date/time parsing: an unparseable (or non-finite)
      // key is malformed — reported, isolated, never actionable.
      var startMs = LegacySlotTimeParser.toComparableTime(row.sort_key);
      if (startMs === null || !isFinite(startMs)) {
        diagnostics.push({
          code: 'MALFORMED_SORT_KEY',
          slotId: AffectedAppointmentDiscoveryService._raw(row.slot_id),
          evidence: {
            status: AffectedAppointmentDiscoveryService._raw(row.status),
            rawSortKey: AffectedAppointmentDiscoveryService._raw(row.sort_key)
          }
        });
        continue; // reported, never actionable, never silently discarded
      }

      if (startMs < fromMs || startMs >= toMs) continue; // outside [from, to)

      if (row.status === Config.VOCABULARY.STATUS.RESERVED) {
        var untilMs = AffectedAppointmentDiscoveryService._expiryMs(row.reserved_until_unix);
        if (untilMs === null) {
          diagnostics.push({
            code: 'MALFORMED_RESERVATION_EXPIRY',
            slotId: AffectedAppointmentDiscoveryService._raw(row.slot_id),
            evidence: {
              rawReservedUntilUnix: AffectedAppointmentDiscoveryService._raw(row.reserved_until_unix)
            }
          });
          continue; // reported, never actionable, never silently discarded
        }
        if (untilMs <= evaluatedAtMs) continue; // expired reservation — excluded
      }

      var entry = {
        item: AffectedAppointmentDiscoveryService._buildItem(row, scope),
        startMs: startMs
      };
      if (row.status === Config.VOCABULARY.STATUS.CONFIRMED) confirmed.push(entry);
      else reserved.push(entry);
    }

    // Deterministic ordering independent of storage row order:
    // appointment start ascending, then slot_id ascending.
    var byStartThenId = function(a, b) {
      if (a.startMs !== b.startMs) return a.startMs - b.startMs;
      var aId = String(a.item.slotId);
      var bId = String(b.item.slotId);
      if (aId < bId) return -1;
      if (aId > bId) return 1;
      return 0;
    };
    confirmed.sort(byStartThenId);
    reserved.sort(byStartThenId);

    // Deterministic diagnostics semantics regardless of storage row order.
    diagnostics.sort(function(a, b) {
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      var aId = String(a.slotId);
      var bId = String(b.slotId);
      if (aId < bId) return -1;
      if (aId > bId) return 1;
      return 0;
    });

    var confirmedItems = confirmed.map(function(entry) { return entry.item; });
    var reservedItems = reserved.map(function(entry) { return entry.item; });

    return Result.ok({
      sourceStatus: 'READ_OK',
      evaluatedAt: evaluatedAt.toISOString(),
      evaluatedAtMs: evaluatedAtMs,
      scope: scope,
      window: { fromMs: fromMs, toMs: toMs },
      completeness: AffectedAppointmentDiscoveryService.COMPLETENESS,
      affected: confirmedItems.concat(reservedItems),
      affectedConfirmed: confirmedItems,
      affectedReserved: reservedItems,
      counts: {
        confirmed: confirmedItems.length,
        reserved: reservedItems.length,
        total: confirmedItems.length + reservedItems.length,
        malformed: diagnostics.length
      },
      diagnostics: diagnostics
    });
  },

  /**
   * Normalizes a window bound to epoch ms.
   * Accepts a Date or a finite number (epoch ms); anything else is rejected
   * (no string parsing — no second date parser is introduced).
   * @param {*} value
   * @returns {number|null}
   */
  _toEpochMs: function(value) {
    if (value instanceof Date) {
      var ms = value.getTime();
      return isFinite(ms) ? ms : null;
    }
    if (typeof value === 'number' && isFinite(value)) return value;
    return null;
  },

  /**
   * Scope is preserved as logical metadata { doctorId, clinicId }. The v1
   * Availability schema does not physically partition rows by that scope;
   * no multi-clinic behavior is implied or performed.
   * @param {*} scope
   * @returns {Result}
   */
  _normalizeScope: function(scope) {
    if (scope === undefined || scope === null) {
      return Result.ok({ doctorId: null, clinicId: null });
    }
    if (typeof scope !== 'object' || scope instanceof Date || Array.isArray(scope)) {
      return Result.fail(
        'INVALID_DISCOVERY_SCOPE',
        'M4-E scope must be an object { doctorId, clinicId } when provided',
        { scope: String(scope) }
      );
    }
    return Result.ok({
      doctorId: scope.doctorId !== undefined ? scope.doctorId : null,
      clinicId: scope.clinicId !== undefined ? scope.clinicId : null
    });
  },

  /**
   * Reservation expiry to epoch ms, strictly:
   * - number            ⇒ used as-is when finite;
   * - non-empty string  ⇒ Number(...) when finite;
   * - anything else (missing, empty, object, NaN, ±Infinity) ⇒ null,
   *   which the caller reports as MALFORMED_RESERVATION_EXPIRY.
   * Note: the empty string is deliberately NOT Number-coerced to 0 — a
   * missing expiry boundary is malformed evidence, not an expired booking.
   * @param {*} value
   * @returns {number|null}
   */
  _expiryMs: function(value) {
    if (typeof value === 'number') return isFinite(value) ? value : null;
    if (typeof value === 'string') {
      var trimmed = value.trim();
      if (trimmed === '') return null;
      var parsed = Number(trimmed);
      return isFinite(parsed) ? parsed : null;
    }
    return null;
  },

  /**
   * Default evidence DTO — intentionally minimal and PII-free.
   * No patient name, phone, raw calendar event id, or conversation data.
   * M4-F will re-read the current Slot at action time.
   * @param {Object} row
   * @param {Object} scope
   * @returns {Object}
   */
  _buildItem: function(row, scope) {
    return {
      slotId: AffectedAppointmentDiscoveryService._raw(row.slot_id),
      status: AffectedAppointmentDiscoveryService._raw(row.status),
      scheduledDate: row.date !== undefined ? row.date : null,
      scheduledTime: row.time !== undefined ? row.time : null,
      isAvailable: false, // canonical check already proved operational unavailability
      impactReason: AffectedAppointmentDiscoveryService.IMPACT_REASON,
      impactReasonSource: AffectedAppointmentDiscoveryService.IMPACT_REASON_SOURCE,
      scope: { doctorId: scope.doctorId, clinicId: scope.clinicId }
    };
  },

  /** @returns {*} the raw value, with undefined/null normalized to '' */
  _raw: function(value) {
    return value === undefined || value === null ? '' : value;
  }
};
