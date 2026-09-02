#!/usr/bin/env node
/**
 * Fix three P0 blockers in M4-D implementation:
 * 
 * P0-1: Add validation for slot_generation_days BEFORE calling calculateGenerationPlan()
 * P0-2: Add upper bound to reconciliation query to match Horizon semantics
 * P0-3: Move decision calculation inside atomicUpdate and use fresh row
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'AvailabilityHorizonMaintainer.js');
let content = fs.readFileSync(filePath, 'utf-8');

console.log('🔧 Fixing P0 blockers in M4-D implementation...\n');

// ═══════════════════════════════════════════════════════════════
// FIX P0-1: Add slot_generation_days validation before calculateGenerationPlan()
// ═══════════════════════════════════════════════════════════════

console.log('P0-1: Adding slot_generation_days validation...');

const oldStep4a = `      // ── Step 4a: Find latest sort key (for horizon calculation) ──
      var latestResult = SlotRepository.findLatestSortKey();`;

const newStep4a = `      // ── Step 4a: Validate slot_generation_days (M4-D fail-closed) ──
      var targetDays = parseInt(settings.slot_generation_days, 10);
      if (isNaN(targetDays) || targetDays <= 0) {
        var daysFail = Result.fail(
          'INVALID_SLOT_GENERATION_DAYS',
          'slot_generation_days must be a positive integer',
          { value: settings.slot_generation_days }
        );
        LogRepository.write({
          timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
          slotId: '', stage: 'END', success: false, durationMs: null,
          error: JSON.stringify({ reason: daysFail.error.code })
        });
        return daysFail;
      }

      // ── Step 4b: Find latest sort key (for horizon calculation) ──
      var latestResult = SlotRepository.findLatestSortKey();`;

content = content.replace(oldStep4a, newStep4a);

// Update the step numbering
content = content.replace(
  /\/\/ ── Step 4b: Calculate generation plan/,
  '// ── Step 4c: Calculate generation plan'
);
content = content.replace(
  /\/\/ ── Step 4c: Read ALL slots in generation window/,
  '// ── Step 4d: Read ALL slots in generation window'
);
content = content.replace(
  /\/\/ ── Step 4d: Read future non-terminal slots/,
  '// ── Step 4e: Read future non-terminal slots'
);

console.log('✅ P0-1 fixed: slot_generation_days validation added\n');

// ═══════════════════════════════════════════════════════════════
// FIX P0-2: Add upper bound to reconciliation query
// ═══════════════════════════════════════════════════════════════

console.log('P0-2: Adding upper bound to reconciliation query...');

const oldReconciliationQuery = `      // ── Step 4e: Read future non-terminal slots (for reconciliation) ──
      var futureSlots;
      try {
        futureSlots = SlotRepository.query(function(row) {
          var sortValue = LegacySlotTimeParser.toComparableTime(row.sort_key);
          if (sortValue === null) return false;
          return sortValue >= nowMs;
        });
      } catch (e) {
        var slotsFail = Result.fail(
          'SLOT_QUERY_FAILED',
          'Failed to query future slots',
          e.message
        );
        LogRepository.write({
          timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
          slotId: '', stage: 'END', success: false, durationMs: null,
          error: JSON.stringify({ reason: slotsFail.error.code })
        });
        return slotsFail;
      }`;

const newReconciliationQuery = `      // ── Step 4e: Read future non-terminal slots (for reconciliation) ──
      // Reconciliation must be bounded by Horizon to match materialization window
      // Calculate reconciliation upper bound based on Horizon semantics
      var reconciliationUpperBoundMs;
      if (latestSortKey) {
        // If slots exist, reconciliation window extends from now to (latestSlotDate + targetDays)
        var latestSlotMs = LegacySlotTimeParser.toComparableTime(latestSortKey);
        if (latestSlotMs !== null) {
          // Find the start of the latest slot's day
          var latestSlotDate = new Date(latestSlotMs);
          latestSlotDate.setHours(0, 0, 0, 0);
          // Reconciliation window: nowMs to (latestSlotDate + targetDays)
          var reconciliationEndDate = new Date(latestSlotDate.getTime());
          reconciliationEndDate.setDate(reconciliationEndDate.getDate() + targetDays);
          reconciliationUpperBoundMs = reconciliationEndDate.getTime();
        } else {
          // Fallback: use plan-based window
          if (plan.needsGeneration && plan.startDate && plan.daysCount > 0) {
            var planEndDate = new Date(plan.startDate.getTime());
            planEndDate.setDate(planEndDate.getDate() + plan.daysCount);
            reconciliationUpperBoundMs = planEndDate.getTime();
          } else {
            // No generation needed, reconciliation window = nowMs to nowMs (empty)
            reconciliationUpperBoundMs = nowMs;
          }
        }
      } else {
        // No existing slots, reconciliation window = nowMs to (today + targetDays)
        var today = new Date();
        today.setHours(0, 0, 0, 0);
        var reconciliationEndDate = new Date(today.getTime());
        reconciliationEndDate.setDate(reconciliationEndDate.getDate() + targetDays);
        reconciliationUpperBoundMs = reconciliationEndDate.getTime();
      }

      var futureSlots;
      try {
        futureSlots = SlotRepository.query(function(row) {
          var sortValue = LegacySlotTimeParser.toComparableTime(row.sort_key);
          if (sortValue === null) return false;
          // Reconciliation bounded by Horizon: [nowMs, reconciliationUpperBoundMs)
          return sortValue >= nowMs && sortValue < reconciliationUpperBoundMs;
        });
      } catch (e) {
        var slotsFail = Result.fail(
          'SLOT_QUERY_FAILED',
          'Failed to query future slots',
          e.message
        );
        LogRepository.write({
          timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
          slotId: '', stage: 'END', success: false, durationMs: null,
          error: JSON.stringify({ reason: slotsFail.error.code })
        });
        return slotsFail;
      }`;

content = content.replace(oldReconciliationQuery, newReconciliationQuery);

console.log('✅ P0-2 fixed: Reconciliation bounded by Horizon\n');

// ═══════════════════════════════════════════════════════════════
// FIX P0-3: Use fresh row in atomicUpdate decision
// ═══════════════════════════════════════════════════════════════

console.log('P0-3: Using fresh row in atomicUpdate decision...');

const oldAtomicUpdate = `      var shouldBeAvailable = evalResult.data.available;
      var currentlyAvailable = SlotRepository.isOperationallyAvailable(slot.is_available);

      if (shouldBeAvailable !== currentlyAvailable) {
        var updateResult = SlotRepository.atomicUpdate(slot.slot_id, function() {
          return Result.ok({ is_available: shouldBeAvailable });
        });`;

const newAtomicUpdate = `      var shouldBeAvailable = evalResult.data.available;

      // atomicUpdate reads fresh row and makes final decision inside atomic boundary
      var updateResult = SlotRepository.atomicUpdate(slot.slot_id, function(freshRow) {
        // Use fresh row to verify slot is still eligible for reconciliation
        if (!freshRow) {
          return Result.fail('SLOT_NOT_FOUND', 'Slot no longer exists');
        }

        // Check terminal status on fresh row (may have changed since snapshot)
        var TERMINAL_STATUSES = {
          EXPIRED: true,
          CANCELLED: true,
          COMPLETED: true,
          NO_SHOW: true
        };
        if (TERMINAL_STATUSES[freshRow.status]) {
          return Result.fail('TERMINAL_SLOT', 'Slot is in terminal state');
        }

        // Final decision based on fresh row's current availability
        var currentlyAvailable = SlotRepository.isOperationallyAvailable(freshRow.is_available);
        
        // Only update if there's actually a change needed
        if (shouldBeAvailable === currentlyAvailable) {
          return Result.ok({}); // No change needed
        }

        return Result.ok({ is_available: shouldBeAvailable });
      });

      // Only count as reconciled if the update succeeded AND made a change
      if (updateResult.ok && updateResult.data && Object.keys(updateResult.data).length > 0) {`;

content = content.replace(oldAtomicUpdate, newAtomicUpdate);

// Fix the closing brace for the reconciliation count
const oldClosing = `        if (!updateResult.ok) {
          errors += 1;
          errorDetails.push({
            slotId: slot.slot_id,
            reason: updateResult.error ? updateResult.error.code : 'UPDATE_FAILED'
          });
          continue;
        }
        reconciled += 1;
      }`;

const newClosing = `        if (!updateResult.ok) {
          errors += 1;
          errorDetails.push({
            slotId: slot.slot_id,
            reason: updateResult.error ? updateResult.error.code : 'UPDATE_FAILED'
          });
          continue;
        }
        reconciled += 1;
      } else if (!updateResult.ok) {
        errors += 1;
        errorDetails.push({
          slotId: slot.slot_id,
          reason: updateResult.error ? updateResult.error.code : 'UPDATE_FAILED'
        });
      }`;

content = content.replace(oldClosing, newClosing);

console.log('✅ P0-3 fixed: Fresh row used in atomicUpdate decision\n');

// ═══════════════════════════════════════════════════════════════
// Write the fixed file
// ═══════════════════════════════════════════════════════════════

fs.writeFileSync(filePath, content, 'utf-8');

console.log('═══════════════════════════════════════════════════════════════');
console.log('✅ All P0 blockers fixed successfully!');
console.log('═══════════════════════════════════════════════════════════════');
console.log('\nSummary:');
console.log('  P0-1: slot_generation_days validation added (fail-closed)');
console.log('  P0-2: Reconciliation bounded by Horizon (no out-of-range updates)');
console.log('  P0-3: Fresh row used in atomicUpdate (per-slot linearization)');
console.log('\nNext steps:');
console.log('  1. Run: node --check AvailabilityHorizonMaintainer.js');
console.log('  2. Run: node tests/HardeningM4D.test.js');
console.log('  3. Run: for test in tests/Hardening*.test.js; do node "$test"; done');
console.log('  4. Update tests to verify the three fixes');
console.log('');
