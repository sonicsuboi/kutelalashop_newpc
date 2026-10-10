// Email báo cho shop khi có đơn hàng hoặc tin nhắn mới, gửi qua dịch vụ Resend (https://resend.com).
// Dùng API qua HTTPS thay vì SMTP vì host miễn phí thường chặn cổng SMTP.
//
// Bật bằng cách đặt RESEND_API_KEY trong file .env (và trong Environment của host). Email gửi tới
// NOTIFY_EMAIL, không đặt thì gửi tới email của shop ở trang quản trị (/admin/thong-tin).
// Chưa xác minh tên miền riêng với Resend thì chỉ gửi được tới chính email đã đăng ký tài khoản Resend.
const KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || 'onboarding@resend.dev';

const enabled = Boolean(KEY);
const recipient = (site) => process.env.NOTIFY_EMAIL || site.email;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Gửi một email cho shop. Trả về { ok, error }; không ném lỗi để việc đặt hàng không bị ảnh hưởng.
async function notify(site, subject, html) {
  if (!enabled) return { ok: false, error: 'Chưa đặt RESEND_API_KEY.' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${site.name} <${FROM}>`, to: [recipient(site)], subject, html }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return { ok: true };
    const error = `Resend trả về ${res.status}: ${(await res.text()).slice(0, 300)}`;
    console.error('Không gửi được email báo:', error);
    return { ok: false, error };
  } catch (err) {
    console.error('Không gửi được email báo:', err.message || err.code);
    return { ok: false, error: err.message || String(err.code) };
  }
}

const row = (label, value) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${label}</td><td style="padding:4px 0"><b>${value}</b></td></tr>`;

// order: { code, name, phone, address, note, total, shipping, payment }, lines: kết quả cartLines()
function orderEmail({ order, lines, formatPrice, adminUrl }) {
  const items = lines.map((l) => `<li>${esc(l.product.name)}${l.product.code ? ` (${esc(l.product.code)})` : ''}`
    + ` – ${esc([l.colorName, l.sizeLabel && `size ${l.sizeLabel}`].filter(Boolean).join(', '))} × ${l.qty}: ${formatPrice(l.subtotal)}</li>`).join('');
  return `<div style="font:14px/1.5 Arial,sans-serif;color:#111">
    <h2 style="margin:0 0 12px">Đơn hàng mới ${esc(order.code)}</h2>
    <table style="border-collapse:collapse">${row('Khách', esc(order.name))}${row('Điện thoại', esc(order.phone))}${row('Địa chỉ', esc(order.address))}
      ${order.note ? row('Ghi chú', esc(order.note)) : ''}${row('Thanh toán', esc(order.payment))}
      ${order.shipping ? row('Phí vận chuyển', formatPrice(order.shipping)) : ''}${row('Tổng cộng', formatPrice(order.total))}</table>
    <ul style="padding-left:18px">${items}</ul>
    <p><a href="${esc(adminUrl)}">Mở đơn trong trang quản trị</a></p></div>`;
}

function messageEmail({ message, adminUrl }) {
  return `<div style="font:14px/1.5 Arial,sans-serif;color:#111">
    <h2 style="margin:0 0 12px">Tin nhắn mới từ trang Liên hệ</h2>
    <table style="border-collapse:collapse">${row('Khách', esc(message.name))}${message.phone ? row('Điện thoại', esc(message.phone)) : ''}${message.email ? row('Email', esc(message.email)) : ''}</table>
    <p style="white-space:pre-line">${esc(message.message)}</p>
    <p><a href="${esc(adminUrl)}">Mở hộp tin nhắn</a></p></div>`;
}

module.exports = { enabled, recipient, notify, orderEmail, messageEmail };
