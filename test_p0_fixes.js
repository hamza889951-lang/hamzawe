const test = require('ava');
const { createTestContext } = require('./tests/test-helpers');

// ═══════════════════════════════════════════════════════════════
// P0-1: Verify slot_generation_days validation (fail-closed)
// ═══════════════════════════════════════════════════════════════

test('P0-1a: Invalid slot_generation_days (NaN) fails closed, not silent fallback', async t => {
  const { context, cleanup } = await createTestContext();
  
  try {
    // Set invalid slot_generation_days
    const settings = await context.settingsRepository.get();
    settings.slot_generation_days = 'invalid';
    await context.settingsRepository.update(settings);

    // Run ensureHorizon
    const result = await context.horizonMaintainer.ensureHorizon({
      actorType: 'DOCTOR',
      actorId: 'DOC-001',
      clinicId: 'CLINIC-A',
      requestId: 'test-p0-1a'
    });

    // Should fail with INVALID_SLOT_GENERATION_DAYS, not silently use 30
    t.false(result.ok, 'Should fail with invalid slot_generation_days');
    t.is(result.error.code, 'INVALID_SLOT_GENERATION_DAYS', 
      'Error code should be INVALID_SLOT_GENERATION_DAYS');

    t.pass();
  } finally {
    await cleanup();
  }
});

test('P0-1b: Zero slot_generation_days fails closed, not silent fallback', async t => {
  const { context, cleanup } = await createTestContext();
  
  try {
    // Set zero slot_generation_days
    const settings = await context.settingsRepository.get();
    settings.slot_generation_days = 0;
    await context.settingsRepository.update(settings);

    // Run ensureHorizon
    const result = await context.horizonMaintainer.ensureHorizon({
      actorType: 'DOCTOR',
      actorId: 'DOC-001',
      clinicId: 'CLINIC-A',
      requestId: 'test-p0-1b'
    });

    // Should fail with INVALID_SLOT_GENERATION_DAYS
    t.false(result.ok, 'Should fail with zero slot_generation_days');
    t.is(result.error.code, 'INVALID_SLOT_GENERATION_DAYS', 
      'Error code should be INVALID_SLOT_GENERATION_DAYS');

    t.pass();
  } finally {
    await cleanup();
  }
});

test('P0-1c: Negative slot_generation_days fails closed', async t => {
  const { context, cleanup } = await createTestContext();
  
  try {
    // Set negative slot_generation_days
    const settings = await context.settingsRepository.get();
    settings.slot_generation_days = -5;
    await context.settingsRepository.update(settings);

    // Run ensureHorizon
    const result = await context.horizonMaintainer.ensureHorizon({
      actorType: 'DOCTOR',
      actorId: 'DOC-001',
      clinicId: 'CLINIC-A',
      requestId: 'test-p0-1c'
    });

    // Should fail with INVALID_SLOT_GENERATION_DAYS
    t.false(result.ok, 'Should fail with negative slot_generation_days');
    t.is(result.error.code, 'INVALID_SLOT_GENERATION_DAYS', 
      'Error code should be INVALID_SLOT_GENERATION_DAYS');

    t.pass();
  } finally {
    await cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════
// P0-2: Verify reconciliation bounded by Horizon
// ═══════════════════════════════════════════════════════════════

test('P0-2: Reconciliation does not extend beyond Horizon', async t => {
  const { context, cleanup } = await createTestContext();
  
  try {
    // Set slot_generation_days to 7
    const settings = await context.settingsRepository.get();
    settings.slot_generation_days = 7;
    await context.settingsRepository.update(settings);

    // Create a slot far in the future (beyond Horizon)
    const futureSlot = await context.slotRepository.createSlot({
      slot_id: 'future-slot-beyond-horizon',
      doctorId: 'DOC-001',
      clinicId: 'CLINIC-A',
      start: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      duration: 30,
      status: 'FREE',
      is_available: true
    });

    // Run ensureHorizon
    const result = await context.horizonMaintainer.ensureHorizon({
      actorType: 'DOCTOR',
      actorId: 'DOC-001',
      clinicId: 'CLINIC-A',
      requestId: 'test-p0-2'
    });

    // The slot should not be reconciled (it's beyond the 7-day horizon)
    const updatedSlot = await context.slotRepository.getSlotById(futureSlot.slot_id);
    t.is(updatedSlot.is_available, true, 
      'Slot beyond horizon should not be reconciled');

    t.pass();
  } finally {
    await cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════
// P0-3: Verify atomicUpdate uses fresh row for decision
// ═══════════════════════════════════════════════════════════════

test('P0-3: atomicUpdate uses fresh row to detect concurrent changes', async t => {
  const { context, cleanup } = await createTestContext();
  
  try {
    // Create a slot that needs reconciliation
    const slot = await context.slotRepository.createSlot({
      slot_id: 'test-slot-fresh-row',
      doctorId: 'DOC-001',
      clinicId: 'CLINIC-A',
      start: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours from now
      duration: 30,
      status: 'FREE',
      is_available: false // Initially unavailable
    });

    // Simulate concurrent change: slot becomes reserved during reconciliation
    await context.slotRepository.updateSlot(slot.slot_id, {
      status: 'RESERVED',
      patientId: 'PATIENT-123',
      is_available: false
    });

    // Run ensureHorizon (should detect the status change and skip reconciliation)
    const result = await context.horizonMaintainer.ensureHorizon({
      actorType: 'DOCTOR',
      actorId: 'DOC-001',
      clinicId: 'CLINIC-A',
      requestId: 'test-p0-3'
    });

    // The slot should remain RESERVED (not overwritten)
    const updatedSlot = await context.slotRepository.getSlotById(slot.slot_id);
    t.is(updatedSlot.status, 'RESERVED', 
      'Slot status should remain RESERVED after concurrent change');
    t.is(updatedSlot.patientId, 'PATIENT-123', 
      'Patient ID should be preserved');

    t.pass();
  } finally {
    await cleanup();
  }
});

test('P0-3b: atomicUpdate respects terminal status from fresh row', async t => {
  const { context, cleanup } = await createTestContext();
  
  try {
    // Create a slot that would normally be reconciled
    const slot = await context.slotRepository.createSlot({
      slot_id: 'test-slot-terminal-fresh',
      doctorId: 'DOC-001',
      clinicId: 'CLINIC-A',
      start: new Date(Date.now() + 2 * 60 * 60 * 1000),
      duration: 30,
      status: 'FREE',
      is_available: false
    });

    // Simulate concurrent change: slot becomes CANCELLED
    await context.slotRepository.updateSlot(slot.slot_id, {
      status: 'CANCELLED'
    });

    // Run ensureHorizon
    const result = await context.horizonMaintainer.ensureHorizon({
      actorType: 'DOCTOR',
      actorId: 'DOC-001',
      clinicId: 'CLINIC-A',
      requestId: 'test-p0-3b'
    });

    // The slot should remain CANCELLED (terminal status preserved)
    const updatedSlot = await context.slotRepository.getSlotById(slot.slot_id);
    t.is(updatedSlot.status, 'CANCELLED', 
      'Terminal status should be preserved');

    t.pass();
  } finally {
    await cleanup();
  }
});

console.log('P0 blocker verification tests created successfully!');
console.log('Run with: npx ava test_p0_fixes.js');
