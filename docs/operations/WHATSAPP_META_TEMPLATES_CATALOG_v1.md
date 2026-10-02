# HAMZAWE WhatsApp Template Catalog v1

Operational companion to WHATSAPP-INTERACTIVE-TEMPLATES-v1. Template names are proposals; final Meta-approved name/status remains account-specific.

Meta supports Quick Reply buttons inside approved message templates, with button payloads returned by the webhook when tapped. Source: Meta WhatsApp Cloud API collection. 

## Template set

| Kind | Proposed Meta name | Category | Body parameters | Buttons |
|---|---|---|---|---|
| WELCOME | hamzawe_welcome_booking | Utility candidate | none | حجز موعد -> HAMZAWE_START_BOOKING |
| BOOKING_CONFIRMATION | hamzawe_booking_confirmation | Utility | date, bus, work-start | تأكيد الحجز -> HAMZAWE_CONFIRM; تغيير الموعد -> HAMZAWE_CHANGE |
| BOOKED_ACTIONS | hamzawe_booked_actions | Utility | none | تغيير الموعد -> HAMZAWE_CHANGE; إلغاء الموعد -> HAMZAWE_CANCEL |
| CHANGE_CONFIRMATION | hamzawe_change_confirmation | Utility | date, bus, work-start | تأكيد الحجز -> HAMZAWE_CONFIRM |
| DISRUPTION_PROPOSAL | hamzawe_disruption_proposal | Utility | proposed appointment display | تأكيد الموعد البديل -> HAMZAWE_CONFIRM; رفض الموعد البديل -> HAMZAWE_DECLINE |
| DISRUPTION_NO_ALTERNATIVE | hamzawe_disruption_no_alternative | Utility | none | none |
| REMINDER | hamzawe_appointment_reminder | Utility | date, bus, work-start | تغيير الموعد -> HAMZAWE_CHANGE; إلغاء الموعد -> HAMZAWE_CANCEL |
| REMINDER_NO_BUS | hamzawe_appointment_reminder_no_bus | Utility | date | تغيير الموعد -> HAMZAWE_CHANGE; إلغاء الموعد -> HAMZAWE_CANCEL |

## Proposed Arabic copy

### hamzawe_welcome_booking
أهلاً بك في العيادة. يمكنك بدء حجز موعدك من الزر أدناه.

Button: حجز موعد

### hamzawe_booking_confirmation
تم العثور على موعد مناسب لك.
التاريخ: {{1}}
رقم الباص: {{2}}
يبدأ دوام العيادة الساعة {{3}}.

هل تريد تأكيد هذا الموعد؟

Buttons: تأكيد الحجز | تغيير الموعد

### hamzawe_booked_actions
لديك حجز مؤكد حالياً. اختر الإجراء المطلوب.

Buttons: تغيير الموعد | إلغاء الموعد

### hamzawe_change_confirmation
تم العثور على موعد بديل.
التاريخ: {{1}}
رقم الباص: {{2}}
يبدأ دوام العيادة الساعة {{3}}.

اضغط تأكيد الحجز لتثبيت الموعد الجديد.

Button: تأكيد الحجز

### hamzawe_disruption_proposal
تنبيه مهم بخصوص موعدك.
الموعد البديل المقترح: {{1}}
لم يتم تغيير موعدك بعد. اختر الإجراء المطلوب.

Buttons: تأكيد الموعد البديل | رفض الموعد البديل

### hamzawe_disruption_no_alternative
تنبيه: موعدك الحالي لم يعد متاحاً، ولا يتوفر موعد بديل حالياً.
لم يتم تغيير موعدك. يرجى التواصل مع العيادة أو إرسال رسالة لإعادة الحجز.

### hamzawe_appointment_reminder
تذكير: موعدك يقترب.
التاريخ: {{1}}
رقم الباص: {{2}}
يبدأ دوام العيادة الساعة {{3}}.
يرجى الحضور ضمن وقت دوام العيادة.

Buttons: تغيير الموعد | إلغاء الموعد

### hamzawe_appointment_reminder_no_bus
تذكير: موعدك يقترب بتاريخ {{1}}.
تعذر تحديد رقم الباص حالياً؛ يرجى التواصل مع العيادة.

Buttons: تغيير الموعد | إلغاء الموعد

## Meta configuration rule

Do not put HAMZAWE payload strings into visible button text. Visible labels are Arabic UX; payloads are application protocol values.

For every template containing buttons, Meta button order must exactly match the order declared by HAMZAWE. The runtime supplies the payload for each button index when sending the template.

## Deployment properties

Configure only the actual approved Meta name and language in Script Properties:

WHATSAPP_TEMPLATE_<KIND>_NAME
WHATSAPP_TEMPLATE_<KIND>_LANGUAGE

No token, app secret, WABA ID, or phone-number ID belongs in this document.

## Approval gate

Do not treat a template as production-ready while its Meta status is PENDING or REJECTED. Conversational template failure falls back to the existing plain-text response; business state is never rolled back because presentation failed.
