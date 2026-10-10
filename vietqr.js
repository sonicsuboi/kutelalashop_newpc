// Mã QR chuyển khoản theo chuẩn VietQR (Napas 247): khách quét bằng app ngân hàng bất kỳ,
// số tài khoản, số tiền và nội dung chuyển khoản (mã đơn) được điền sẵn.
// Tài khoản nhận tiền khai báo ở trang quản trị (/admin/thong-tin).
const QRCode = require('qrcode');

// Mã BIN của ngân hàng trong hệ thống Napas
const BANKS = {
  970436: 'Vietcombank',
  970415: 'VietinBank',
  970418: 'BIDV',
  970405: 'Agribank',
  970407: 'Techcombank',
  970422: 'MB Bank',
  970416: 'ACB',
  970432: 'VPBank',
  970423: 'TPBank',
  970403: 'Sacombank',
  970437: 'HDBank',
  970441: 'VIB',
  970443: 'SHB',
  970431: 'Eximbank',
  970426: 'MSB',
  970448: 'OCB',
  970440: 'SeABank',
  970449: 'LPBank',
};

// Mỗi trường của chuỗi QR: mã 2 số + độ dài 2 số + giá trị
const field = (id, value) => id + String(value.length).padStart(2, '0') + value;

// CRC-16/CCITT-FALSE, 4 ký tự hex cuối chuỗi
function crc16(text) {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function payload({ bin, account, amount, content }) {
  const receiver = field('00', 'A000000727') + field('01', field('00', bin) + field('01', account)) + field('02', 'QRIBFTTA');
  const body = field('00', '01') + field('01', '12') + field('38', receiver) + field('53', '704')
    + (amount ? field('54', String(amount)) : '') + field('58', 'VN')
    + (content ? field('62', field('08', content)) : '') + '6304';
  return body + crc16(body);
}

// Tài khoản nhận tiền của shop, null nếu chưa khai báo đủ
function bankOf(site) {
  if (!Object.hasOwn(BANKS, site.bank_bin) || !site.bank_account) return null;
  return { bin: site.bank_bin, name: BANKS[site.bank_bin], account: site.bank_account, holder: site.bank_holder };
}

// { bank, svg, content } để hiện mã QR cho một khoản tiền; null nếu shop chưa khai báo tài khoản
async function transferQr(site, amount, content) {
  const bank = bankOf(site);
  if (!bank) return null;
  const svg = await QRCode.toString(payload({ bin: bank.bin, account: bank.account, amount, content }),
    { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { bank, svg, content };
}

module.exports = { BANKS, bankOf, transferQr, payload, crc16 };
