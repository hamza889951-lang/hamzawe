/**
 * ULID
 * مولّد هويات فريدة قابلة للترتيب الزمني، مستقل عن أي بيانات عمل (CAS-007، CAS-009).
 *
 * تنويه مهم (بطلب المشرف G):
 * ULID أداة تعريف (Identification) وليس أداة أمنية (Security).
 * الجزء العشوائي فيه مولَّد عبر Math.random() وهو غير آمن تشفيرياً.
 * ممنوع استخدامه لأي غرض يتطلب أماناً حقيقياً (مثل رموز تحقق، أو رموز جلسة حساسة).
 * غرضه الوحيد: ضمان تفرّد الهوية وقابليتها للترتيب الزمني، لا أكثر.
 */
const ULID = {
  ENCODING: '0123456789ABCDEFGHJKMNPQRSTVWXYZ',

  /** @param {number} [timestamp] - اختياري، لأغراض الاختبار فقط */
  generate(timestamp) {
    const ts = (timestamp !== undefined) ? timestamp : Clock.now().getTime();
    return this._encodeTime(ts) + this._encodeRandom();
  },

  _encodeTime(timestamp) {
    let str = '';
    for (let i = 9; i >= 0; i--) {
      str = this.ENCODING[timestamp % 32] + str;
      timestamp = Math.floor(timestamp / 32);
    }
    return str;
  },

  _encodeRandom() {
    let str = '';
    for (let i = 0; i < 16; i++) {
      str += this.ENCODING[Math.floor(Math.random() * 32)];
    }
    return str;
  }
};