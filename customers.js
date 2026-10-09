// Tài khoản khách hàng (/tai-khoan): đăng ký và đăng nhập bằng số điện thoại + mật khẩu.
// Khách đăng nhập thì giỏ hàng tự điền họ tên, số điện thoại, địa chỉ đã lưu, xem lại được đơn cũ
// và đánh giá được sản phẩm đã mua.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const db = require('./db');
const { ORDER_STATUS, orderCode } = require('./orders');
const ah = require('./async-handler');

const scrypt = promisify(crypto.scrypt);
// Chưa đặt SESSION_SECRET thì dùng khoá ngẫu nhiên: khách phải đăng nhập lại mỗi lần server khởi động
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const text = (v) => (typeof v === 'string' ? v.trim() : '');
// "+84 912 345 678", "0912.345.678" đều về "0912345678"
const normalPhone = (v) => text(v).replace(/[\s.-]/g, '').replace(/^\+?84/, '0');
const validPhone = (phone) => /^0\d{9,10}$/.test(phone);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 32)).toString('hex')}`;
}
async function checkPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const given = await scrypt(password, salt, 32);
  const saved = Buffer.from(hash, 'hex');
  return saved.length === given.length && crypto.timingSafeEqual(given, saved);
}

// Phiên đăng nhập: cookie "id.hạn.chữ-ký"
const sign = (id, expires) => crypto.createHmac('sha256', SECRET).update(`kh:${id}.${expires}`).digest('hex');
function startSession(res, id) {
  const expires = Date.now() + SESSION_MS;
  res.cookie('kh', `${id}.${expires}.${sign(id, expires)}`, { maxAge: SESSION_MS, httpOnly: true, sameSite: 'lax' });
}
async function currentCustomer(req) {
  const m = /(?:^|;\s*)kh=(\d{1,12})\.(\d{1,15})\.([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie || '');
  if (!m || Number(m[2]) < Date.now()) return null;
  if (!crypto.timingSafeEqual(Buffer.from(m[3]), Buffer.from(sign(m[1], m[2])))) return null;
  return db.one('SELECT id, phone, name, address, created_at FROM customers WHERE id = ?', [Number(m[1])]);
}

// Sai mật khẩu 5 lần thì khoá địa chỉ đó 15 phút
const failures = new Map();
const LOCK_MS = 15 * 60 * 1000;
function isLocked(ip) {
  const f = failures.get(ip);
  if (f && f.until < Date.now()) failures.delete(ip);
  return Boolean(f && f.count >= 5 && f.until >= Date.now());
}

// Chỉ quay về đường dẫn trong web, không nhận địa chỉ web khác
const safeNext = (v) => (typeof v === 'string' && /^\/(?!\/)[^\s\\]*$/.test(v) ? v : '/tai-khoan');

const router = express.Router();

router.get('/dang-ky', (req, res) => {
  if (res.locals.customer) return res.redirect('/tai-khoan');
  res.render('account/register', { title: 'Đăng ký', values: {}, errors: {}, next: safeNext(req.query.next) });
});

router.post('/dang-ky', ah(async (req, res) => {
  const values = {
    name: text(req.body.name).slice(0, 100),
    phone: normalPhone(req.body.phone),
    address: text(req.body.address).slice(0, 300),
  };
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const next = safeNext(req.body.next);
  const errors = {};
  if (!values.name) errors.name = 'Vui lòng nhập họ tên.';
  if (!validPhone(values.phone)) errors.phone = 'Số điện thoại chưa đúng.';
  else if (await db.one('SELECT 1 FROM customers WHERE phone = ?', [values.phone])) {
    errors.phone = 'Số điện thoại này đã có tài khoản. Hãy đăng nhập.';
  }
  if (password.length < 6 || password.length > 100) errors.password = 'Mật khẩu từ 6 ký tự trở lên.';
  if (Object.keys(errors).length) {
    return res.status(400).render('account/register', { title: 'Đăng ký', values, errors, next });
  }
  const { id } = await db.one(
    'INSERT INTO customers (phone, name, address, password_hash) VALUES (?, ?, ?, ?) RETURNING id',
    [values.phone, values.name, values.address || null, await hashPassword(password)]);
  startSession(res, id);
  res.redirect(next);
}));

router.get('/dang-nhap', (req, res) => {
  if (res.locals.customer) return res.redirect('/tai-khoan');
  res.render('account/login', { title: 'Đăng nhập', phone: '', error: '', next: safeNext(req.query.next) });
});

router.post('/dang-nhap', ah(async (req, res) => {
  const phone = normalPhone(req.body.phone);
  const next = safeNext(req.body.next);
  const fail = (status, error) =>
    res.status(status).render('account/login', { title: 'Đăng nhập', phone, error, next });
  if (isLocked(req.ip)) return fail(429, 'Sai mật khẩu quá nhiều lần. Vui lòng thử lại sau 15 phút.');

  const customer = await db.one('SELECT id, password_hash FROM customers WHERE phone = ?', [phone]);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!customer || !(await checkPassword(password, customer.password_hash))) {
    const f = failures.get(req.ip) || { count: 0 };
    failures.set(req.ip, { count: f.count + 1, until: Date.now() + LOCK_MS });
    return fail(401, 'Số điện thoại hoặc mật khẩu không đúng.');
  }
  failures.delete(req.ip);
  startSession(res, customer.id);
  res.redirect(next);
}));

router.post('/dang-xuat', (req, res) => {
  res.clearCookie('kh');
  res.redirect('/');
});

// Mọi trang bên dưới đều cần đăng nhập
router.use((req, res, next) => (res.locals.customer ? next() : res.redirect('/tai-khoan/dang-nhap')));

async function renderAccount(res, { values, errors = {}, status = 200, saved = '' } = {}) {
  const customer = res.locals.customer;
  const orders = await db.query(`
    SELECT o.*, (SELECT COALESCE(SUM(qty), 0) FROM order_items i WHERE i.order_id = o.id)::int AS item_count
    FROM orders o WHERE customer_id = ? ORDER BY id DESC LIMIT 50`, [customer.id]);
  for (const order of orders) {
    order.items = await db.query(`
      SELECT i.name, i.color, i.size, i.size_label, i.qty, p.slug FROM order_items i
      LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = ? ORDER BY i.id`, [order.id]);
  }
  res.status(status).render('account/profile', {
    title: 'Tài khoản', values: values || customer, errors, saved, orders, statuses: ORDER_STATUS, orderCode,
  });
}

router.get('/', ah(async (req, res) => {
  await renderAccount(res, { saved: typeof req.query.ok === 'string' ? req.query.ok : '' });
}));

router.post('/', ah(async (req, res) => {
  const values = { name: text(req.body.name).slice(0, 100), address: text(req.body.address).slice(0, 300) };
  if (!values.name) {
    return renderAccount(res, { values: { ...res.locals.customer, ...values }, errors: { name: 'Vui lòng nhập họ tên.' }, status: 400 });
  }
  await db.run('UPDATE customers SET name = ?, address = ? WHERE id = ?',
    [values.name, values.address || null, res.locals.customer.id]);
  res.redirect('/tai-khoan?ok=thong-tin');
}));

router.post('/mat-khau', ah(async (req, res) => {
  const current = typeof req.body.current === 'string' ? req.body.current : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const row = await db.one('SELECT password_hash FROM customers WHERE id = ?', [res.locals.customer.id]);
  const errors = {};
  if (!(await checkPassword(current, row.password_hash))) errors.current = 'Mật khẩu hiện tại không đúng.';
  else if (password.length < 6 || password.length > 100) errors.password = 'Mật khẩu mới từ 6 ký tự trở lên.';
  if (Object.keys(errors).length) return renderAccount(res, { errors, status: 400 });
  await db.run('UPDATE customers SET password_hash = ? WHERE id = ?', [await hashPassword(password), res.locals.customer.id]);
  res.redirect('/tai-khoan?ok=mat-khau');
}));

module.exports = { router, currentCustomer, hashPassword };
