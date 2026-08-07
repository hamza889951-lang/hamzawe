/**
 * ═══════════════════════════════════════
 * CONTRACT — CommandExecutor
 * ═══════════════════════════════════════
 * يضمن:
 *   - تسجيل بداية ونهاية أي Command تلقائياً في SYSTEM_LOG (لا يعتمد على
 *     تذكّر المبرمج).
 *   - التقاط أي استثناء غير متوقع وتحويله إلى Result.fail بدل تعطل التنفيذ.
 *   - قياس مدة التنفيذ (durationMs).
 * لا يضمن:
 *   - صحة الأمر نفسه أو منطقه الداخلي — تلك مسؤولية fn الممرَّرة.
 *   - أي علاقة بالتوجيه (Routing) — منفصل تماماً عن Router.
 */
const CommandExecutor = {

  /**
   * @param {string} commandName - اسم من Config.VOCABULARY.COMMANDS
   * @param {Object} context - { phone, slotId } لأغراض التسجيل فقط
   * @param {Function} fn - يجب أن تعيد Result
   * @returns {Result}
   */
  execute(commandName, context, fn) {
    const startedAt = Clock.now();

    LogRepository.write({
      timestamp: startedAt,
      command: commandName,
      phone: context.phone || '',
      slotId: context.slotId || '',
      stage: 'START',
      success: null,
      durationMs: null,
      error: ''
    });

    let result;
    try {
      result = fn();
    } catch (e) {
      result = Result.fail('UNEXPECTED_ERROR', e.message, e.stack);
    }

    const durationMs = Clock.now().getTime() - startedAt.getTime();

    LogRepository.write({
      timestamp: Clock.now(),
      command: commandName,
      phone: context.phone || '',
      slotId: context.slotId || '',
      stage: 'END',
      success: result.ok,
      durationMs: durationMs,
      error: result.error ? JSON.stringify(result.error) : ''
    });

    return result;
  }
};