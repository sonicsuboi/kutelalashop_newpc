// Thanh toán thẻ qua cổng VNPay (thẻ ATM nội địa, Visa, Mastercard, JCB, QR).
// Khách nhập thẻ trên trang của VNPay, trang web này không nhận hay lưu số thẻ.
// Cần VNPAY_TMN_CODE và VNPAY_HASH_SECRET trong file .env; thiếu thì tính năng tự tắt.
const crypto = require('node:crypto');

const TMN_CODE = process.env.VNPAY_TMN_CODE || '';
const HASH_SECRET = process.env.VNPAY_HASH_SECRET || '';
const PAY_URL = process.env.VNPAY_URL || 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html';

const enabled = Boolean(TMN_CODE && HASH_SECRET);

// VNPay ký trên chuỗi tham số đã sắp xếp theo tên, mã hoá kiểu form (dấu cách thành "+")
const encode = (value) => encodeURIComponent(value).replace(/%20/g, '+');
const toQuery = (params) =>
  Object.keys(params).sort().map((key) => `${encode(key)}=${encode(params[key])}`).join('&');
const sign = (query) => crypto.createHmac('sha512', HASH_SECRET).update(query, 'utf8').digest('hex');

// yyyyMMddHHmmss theo giờ Việt Nam
function vnTime(date) {
  return new Date(date.getTime() + 7 * 3600 * 1000).toISOString().replace(/\D/g, '').slice(0, 14);
}

function paymentUrl({ orderId, amount, info, ip, returnUrl }) {
  const now = new Date();
  const params = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: TMN_CODE,
    vnp_Amount: String(amount * 100),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: String(orderId),
    vnp_OrderInfo: info,
    vnp_OrderType: 'other',
    vnp_Locale: 'vn',
    vnp_ReturnUrl: returnUrl,
    vnp_IpAddr: ip,
    vnp_CreateDate: vnTime(now),
    vnp_ExpireDate: vnTime(new Date(now.getTime() + 15 * 60 * 1000)),
  };
  const query = toQuery(params);
  return `${PAY_URL}?${query}&vnp_SecureHash=${sign(query)}`;
}

// Kiểm tra chữ ký của kết quả VNPay gửi về (trang quay về của khách hoặc IPN)
function verify(query) {
  const params = {};
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('vnp_') && key !== 'vnp_SecureHash' && key !== 'vnp_SecureHashType' && typeof value === 'string') {
      params[key] = value;
    }
  }
  const expected = Buffer.from(sign(toQuery(params)));
  const given = Buffer.from(String(query.vnp_SecureHash || '').toLowerCase());
  const valid = enabled && expected.length === given.length && crypto.timingSafeEqual(expected, given);
  return {
    valid,
    orderId: Number(params.vnp_TxnRef) || 0,
    amount: Number(params.vnp_Amount) / 100,
    success: params.vnp_ResponseCode === '00' && (params.vnp_TransactionStatus || '00') === '00',
    ref: params.vnp_TransactionNo || null,
  };
}

module.exports = { enabled, paymentUrl, verify, _sign: (params) => sign(toQuery(params)) };
