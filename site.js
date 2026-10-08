// Thông tin shop hiện trên website (tên, email, điện thoại). Mặc định lấy từ config.js,
// phần đã sửa ở trang quản trị (/admin/thong-tin) lưu trong bảng settings.
const db = require('./db');
const { SITE } = require('./config');

async function getSite() {
  const site = { ...SITE };
  for (const row of await db.query('SELECT key, value FROM settings')) {
    if (Object.hasOwn(SITE, row.key)) site[row.key] = row.value;
  }
  return site;
}

async function saveSite(values) {
  for (const key of Object.keys(SITE)) {
    if (values[key] === undefined) continue;
    await db.run(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `, [key, values[key]]);
  }
}

module.exports = { getSite, saveSite };
