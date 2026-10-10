// Cấu hình riêng của máy (mật khẩu quản trị, khoá cổng thanh toán) nằm trong file .env,
// không đưa lên git. Xem .env.example để biết các mục.
const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // chưa có file .env: chạy với mặc định, trang quản trị và thanh toán thẻ sẽ tắt
}

// Thông tin shop dùng chung cho mọi trang. Đây là giá trị mặc định; sửa ở trang quản trị
// (/admin/thong-tin) thì giá trị mới lưu trong database và được dùng thay.
const SITE = {
  name: 'KUTELALA',
  email: 'lienhe@kutelala.example',
  phone: '0900 000 000',
  // Câu giới thiệu hiện dưới tên web trên Google và khi chia sẻ link
  description: 'KUTELALA – giày dép, túi xách và kính mát nữ phong cách tối giản.',
  // Link chat: https://zalo.me/<số điện thoại> và https://m.me/<tên trang Facebook>. Để trống thì không hiện nút.
  zalo: '',
  facebook: '',
  // Mã xác minh Google Search Console (phần content của thẻ meta google-site-verification)
  google_verify: '',
  // Tài khoản nhận chuyển khoản (mã BIN ngân hàng trong vietqr.js, số tài khoản, tên chủ tài khoản).
  // Khai báo đủ thì web có lựa chọn "Chuyển khoản" và bill in kèm mã QR.
  bank_bin: '',
  bank_account: '',
  bank_holder: '',
};

module.exports = { SITE };
