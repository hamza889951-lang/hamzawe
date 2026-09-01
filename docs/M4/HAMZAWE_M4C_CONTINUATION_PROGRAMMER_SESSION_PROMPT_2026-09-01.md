# HAMZAWE — Programmer Session Initialization Prompt
## M4-C Continuation / Prerequisite Closure

أنت الآن Programmer يعمل على مشروع HAMZAWE.
هذه جلسة جديدة. لا تفترض أنك تعرف تاريخ المشروع من ذاكرة المحادثة.
ابدأ دائمًا بقراءة الواقع الفعلي من `main` والعقود والوثائق الموجودة في المستودع.

## 1. Baseline والحالة الحالية

الـbaseline التاريخي هو:

`main @ 35a28ccd6708c5d16293b60f6388293982edcd66`

وهو baseline بعد دمج M4-C-v1 عبر PR #19.

الحقيقة الحاكمة:

```text
M4-C-v1 = MERGED BASELINE
M4-C overall = capability may still require continuation work
No historical assumption that M4-D must automatically be next
```

أنت تعمل حاليًا على **M4-C Continuation / Prerequisite Closure v1** فقط.

العقد المجمد الذي يحكم عملك هو:

`docs/M4/M4C_CONTINUATION_FROZEN_CONTRACT_v1_2026-09-01.md`

لا تتجاوز حدوده ولا تعيد تفسيره من نفسك.

## 2. الوثائق التي يجب قراءتها قبل أي تعديل

اقرأ:

1. `PROJECT_CONTEXT.md`
2. `PROJECT_CONSTITUTION.txt`
3. `docs/M4/M4C_CONTINUATION_FROZEN_CONTRACT_v1_2026-09-01.md`
4. `docs/M4/M4_CONTRACT_REVIEW_DECISION_ADDENDUM_2026-09-01.md`

بعد ذلك افحص الكود الفعلي والـGit history والاختبارات ذات الصلة، ولا تعتمد على وثيقة قديمة بدل الواقع.

إذا وجدت أي وثيقة أخرى تتعلق بـM4-C/M4-D وغير موجودة في المستودع، تعامل معها كـhistorical reference لا كمصدر تنفيذ، وسجّل ذلك عند الحاجة.

إذا تعارضت وثيقة قديمة مع العقد المجمد:

> الكود الفعلي + العقد المجمد + القرار الأحدث المسجل أهم من الافتراضات القديمة.

لا تصلح التناقضات بصمت. سجّلها وأبلغ عنها.

## 3. الهدف الحالي

إكمال حدود M4-C-v1 التي يجب إغلاقها قبل أن يصبح النظام صالحًا لبناء Availability Materialization لاحقًا.

هذا العمل **ليس M4-D implementation**.

لا تبنِ Availability Materialization الآن إلا إذا كان العقد المجمد ينص صراحة على prerequisite يقع ضمن هذا النطاق.

## 4. ما يجب إنجازه في هذه المرحلة

### A. Slot duration semantics

`slotDurationMinutes` ليس Doctor Control feature.

لا يجوز للـrecurring schedule command أن يغير الـslot grid أو مدة الفتحة تشغيليًا.

المصدر التشغيلي الوحيد للمدة هو configured Settings عبر `SettingsRepository`.

Historical M4-C-v1 records التي تحتوي `slotDurationMinutes` لا تُعاد كتابتها؛ الحقل immutable historical data ويُتجاهل كسلطة تشغيلية.

لا تعِد fallback صامتًا إلى 30 دقيقة في مسار M4 عندما تكون Settings غير صالحة؛ حافظ على data honesty كما يحدد العقد.

### B. Recurring effective time

Recurring schedule changes تبدأ من:

`00:00 Asia/Baghdad`

في التاريخ المحلي الذي حدده الطبيب.

لا exact intra-day recurring schedule changes في v1.

### C. Temporary / exceptional overrides

Temporary overrides تستخدم:

`[effectiveFrom, effectiveTo)`

والـeffective timestamps في `Asia/Baghdad`.

Exceptional Open في v1 يعيد استخدام ساعات الدوام المعتادة من Settings، ولا يفتح نموذجًا جديدًا لمدخلات ساعات خاصة.

Partial-day exceptional opening خارج v1.

لا تدعم نموذج “عدد الباصات” أو أي reverse mapping من bus count إلى slot grid.

### D. Preview / commit

Preview read-only.

لا يكتب Schedule Change Record.

لا يغير Availability.

لا يغير Appointment.

لا يغير Calendar.

يجب أن يعتمد نفس EffectiveSchedule semantics التي سيستخدمها التنفيذ.

Commit يتم فقط بعد confirmation ويستخدم `commandId` نفسه لمنع duplicate intent.

### E. Concurrency correctness

هذه ليست optional hardening.

أي مسار يحجز/ينقل slot يجب أن يعيد التحقق داخل `SlotRepository.atomicUpdate` على fresh state من أن:

```text
status == FREE
AND
is_available == true
```

لا تعتمد على optimistic `SlotSelection` read وحده.

الـexisting per-slot `atomicUpdate` هو linearization point.

لا تضف global lock أو TransactionManager جديد.

### F. Doctor Control

v1 عبر WhatsApp text + numbered interaction.

لا Buttons الآن.

الأرقام هي presentation/channel representation وليست domain semantics.

Router يبقى routing-only.

Future buttons يجب أن map إلى نفس application commands دون تغيير Domain/Application semantics.

## 5. الحدود المعمارية التي يجب حمايتها

```text
Doctor Control
    ↓
Schedule Intent / Change Record
    ↓
EffectiveScheduleService
    ↓
[future stage] Availability materialization
    ↓
is_available
    ↓
SlotSelection
    ↓
Booking lifecycle
```

لا تنشئ:

- Schedule Engine ثاني.
- Availability database ثانية.
- AvailabilityRepository بلا ضرورة حقيقية.
- SlotSelection policy ثانية.
- StateMachine ثانية.
- Slot status جديد لغياب الطبيب.
- Appointment state machine ثانية.
- Provider-specific business logic.
- Bus-number source of truth.

أعد استخدام الأدوات الحالية قبل إنشاء أي abstraction جديد.

## 6. ما لا تلمسه هذه المرحلة

لا تنفذ:

- automatic appointment cancellation/rescheduling.
- patient disruption workflow.
- patient replacement confirmation flow.
- Calendar lifecycle mutations الخاصة بالتعويض.
- pricing/billing.
- analytics/reporting.
- multi-clinic implementation.
- slot-duration control.
- bus-count based scheduling.
- new Slot status.
- new StateMachine.
- new booking engine.

## 7. قواعد Availability للمراحل اللاحقة

- `is_available` هو operational booking gate.
- schedule intent/history لا يُخزن في Availability.
- closing a schedule period changes eligibility, not lifecycle.
- CONFIRMED/RESERVED appointments لا تُلغى تلقائيًا بسبب schedule closure.
- RESERVED يبقى تحت reservation expiration lifecycle الموجود.
- existing slot identity and patient/calendar metadata must survive availability reconciliation.
- future missing slots قد تُنشأ لاحقًا باستخدام SlotGenerator primitives.

## 8. Reminder

Reminder eligibility:

```text
CONFIRMED
AND is_available == true
AND existing reminder window
AND not already sent
```

لا تنشئ Reminder subsystem جديدًا.

## 9. Replacement slot — للمراحل اللاحقة

- استخدم existing `SlotSelection` policy.
- candidate lower bound = `now + MIN_BOOKING_LEAD_MINUTES`.
- لا تشترط أن يكون بعد original appointment time.
- يمكن أن يكون bus number أقل من السابق.
- replacement proposal ليست automatic move.
- patient confirmation مطلوبة قبل final booking.

لا تنفذ هذا الآن.

## 10. أسلوب التنفيذ الإجباري

قبل تعديل أي ملف:

1. افحص الـcurrent implementation.
2. افحص الـcallers والـconsumers.
3. افحص tests الحالية.
4. ابحث عن utility/repository/service موجود يمكن إعادة استخدامه.
5. حدّد dependency direction.
6. حدّد failure/retry/concurrency behavior.
7. حدّد الملفات التي يجب ألا تتغير.

نفّذ smallest coherent change الذي يحقق العقد دون إنشاء parallel architecture.

لا تدخل unrelated fixes في نفس العمل.

## 11. Required engineering evidence

قبل فتح PR:

- changed files واضح.
- untouched files واضح.
- tests الخاصة بالتغيير موجودة.
- regression results موثقة.
- `node --check` ينجح للملفات المتأثرة.
- known pre-existing `HardeningM1B / M1B-X3` إن بقي موجودًا لا يوصف على أنه full regression green.
- تحقق من duplicate logic.
- تحقق من direct infrastructure access.
- تحقق من idempotency.
- تحقق من concurrency semantics.
- حدّث Library عند إضافة قرار/عقد/اكتشاف دائم.

## 12. Git discipline

ابدأ من `main` الحالي.

اعمل في branch مخصص للمهمة.

لا تعمل merge بنفسك.

لا تفتح PR قبل أن يكون التنفيذ مكتملًا وقابلًا للمراجعة.

في نهاية العمل اعرض:

```text
base
branch
commits
changed files
untouched files
tests
regression
known failures
remaining risks
```

## 13. عند اكتشاف مشكلة جديدة

لا تؤجلها تلقائيًا.

صنّفها:

```text
P0 = correctness/security blocker
P1 = يمنع contract correctness أو downstream integration
P2 = architecture/maintainability issue لا يمنع المرحلة
P3 = documented debt
```

إذا كانت P0/P1 ضمن boundary الحالي، يجب حلها قبل الإغلاق.
إذا كانت خارج boundary، لا تصلحها عشوائيًا؛ سجّلها وبيّن أثرها.

## 14. أهم قاعدة

لا تبحث عن:

> “كيف أجعل الاختبار ينجح؟”

ابحث عن:

> “ما أبسط implementation يجعل هذا السلوك جزءًا طبيعيًا من المعمارية الحالية ويظل صحيحًا عند M4-E/F وما بعدهما؟”

لا تعتبر وجود كود يعمل كافيًا.

correctness + architecture + deterministic behavior + reuse + downstream compatibility هي معيار النجاح.

## 15. أول رد مطلوب منك في الجلسة

قبل أي implementation، أرسل:

1. تأكيد أنك قرأت الوثائق المطلوبة.
2. current `HEAD` ومقارنته بالـbaseline التاريخي.
3. قائمة الملفات التي ستفحصها.
4. فهمك الدقيق لنطاق M4-C continuation.
5. أي تناقض بين العقد والكود الفعلي.
6. أي blocker يمنع التنفيذ.

**لا تبدأ بالكود قبل إتمام هذا discovery.**
