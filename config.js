// Cấu hình riêng của máy (mật khẩu quản trị, khoá cổng thanh toán) nằm trong file .env,
// không đưa lên git. Xem .env.example để biết các mục.
const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // chưa có file .env: chạy với mặc định, trang quản trị và thanh toán thẻ sẽ tắt
}

// Thông tin shop dùng chung cho mọi trang
const SITE = {
  name: 'KUTELALA',
  email: 'lienhe@kutelala.example',
  phone: '0900 000 000',
};

module.exports = { SITE };
