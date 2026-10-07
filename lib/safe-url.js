/** 공개 저장소 안전장치(git-guard)의 개인정보 패턴(휴대폰·주민번호 모양 숫자열)에 걸리는 이미지 주소를 걸러낸다.
 *  아고다 사진 주소의 긴 해시 숫자가 오탐되므로, 해당 사진은 쓰지 않고 다른 숙소 사진으로 대체한다. */
const PII = [/(?<![\d])01[016789][-. ]?\d{3,4}[-. ]?\d{4}(?![\d])/, /(?<![\d])\d{6}[- ]?[1-4]\d{6}(?![\d])/];
const piiLike = s => PII.some(re => re.test(String(s || '')));
const safeImg = u => (u && !piiLike(u) ? u : '');
module.exports = { piiLike, safeImg };
