// Trang quản trị (/admin): đơn hàng và kho sản phẩm.
// Đăng nhập bằng mật khẩu ADMIN_PASSWORD trong file .env; chưa đặt mật khẩu thì trang quản trị tắt.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const db = require('./db');
const { fold } = require('./text');
const { retailPrice } = require('./pricing');
const { CATEGORIES, sizesOf, colorsOf, variantsOf, stockMap, setStock } = require('./catalog');
const { ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, orderCode, cancelOrder, markPaid } = require('./orders');
const { syncProductMedia } = require('./media');

const PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(`admin:${PASSWORD}`).digest('hex');
const SESSION_MS = 12 * 60 * 60 * 1000;

const router = express.Router();
router.enabled = Boolean(PASSWORD);

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const int = (v) => (/^\d{1,9}$/.test(text(v)) ? Number(text(v)) : null);
const sha = (s) => crypto.createHash('sha256').update(s).digest();

// Phiên đăng nhập: cookie "hạn.chữ-ký", ký bằng SESSION_SECRET
const signSession = (expires) => crypto.createHmac('sha256', SECRET).update(String(expires)).digest('hex');
function isLoggedIn(req) {
  const m = /(?:^|;\s*)admin=(\d{1,15})\.([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie || '');
  if (!m || Number(m[1]) < Date.now()) return false;
  return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(signSession(m[1])));
}

// Sai mật khẩu 5 lần thì khoá địa chỉ đó 15 phút
const failures = new Map();
const LOCK_MS = 15 * 60 * 1000;
function isLocked(ip) {
  const f = failures.get(ip);
  if (f && f.until < Date.now()) failures.delete(ip);
  return Boolean(f && f.count >= 5 && f.until >= Date.now());
}

const PRODUCT_ROWS = `
  SELECT p.*,
    (SELECT COALESCE(SUM(qty), 0) FROM stock s WHERE s.product_id = p.id) AS stock_total,
    (SELECT COUNT(*) FROM product_images i WHERE i.product_id = p.id) AS media_count
  FROM products p`;
const getProduct = (id) => db.prepare(`${PRODUCT_ROWS} WHERE p.id = ?`).get(Number(id));

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.locals.admin = {
    statuses: ORDER_STATUS, methods: PAYMENT_METHOD, payments: PAYMENT_STATUS,
    categories: CATEGORIES, orderCode, section: req.path.split('/')[1] || '',
  };
  next();
});

router.get('/dang-nhap', (req, res) => {
  if (isLoggedIn(req)) return res.redirect('/admin');
  res.render('admin/login', { title: 'Đăng nhập', enabled: router.enabled, error: '' });
});

router.post('/dang-nhap', (req, res) => {
  const fail = (status, error) =>
    res.status(status).render('admin/login', { title: 'Đăng nhập', enabled: router.enabled, error });
  if (!router.enabled) return fail(403, '');
  if (isLocked(req.ip)) return fail(429, 'Sai mật khẩu quá nhiều lần. Vui lòng thử lại sau 15 phút.');

  if (!crypto.timingSafeEqual(sha(text(req.body.password)), sha(PASSWORD))) {
    const f = failures.get(req.ip) || { count: 0 };
    failures.set(req.ip, { count: f.count + 1, until: Date.now() + LOCK_MS });
    return fail(401, 'Mật khẩu không đúng.');
  }
  failures.delete(req.ip);
  const expires = Date.now() + SESSION_MS;
  // sameSite strict: trang khác không thể gửi form thay người quản trị
  res.cookie('admin', `${expires}.${signSession(expires)}`, {
    maxAge: SESSION_MS, httpOnly: true, sameSite: 'strict', path: '/admin',
  });
  res.redirect('/admin');
});

router.post('/dang-xuat', (req, res) => {
  res.clearCookie('admin', { path: '/admin' });
  res.redirect('/admin/dang-nhap');
});

// Mọi trang bên dưới đều cần đăng nhập
router.use((req, res, next) => (isLoggedIn(req) ? next() : res.redirect('/admin/dang-nhap')));

// Tổng quan
router.get('/', (req, res) => {
  const count = (where) => db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE ${where}`).get().n;
  const sum = (where) => db.prepare(`SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE ${where}`).get().n;
  const products = db.prepare(PRODUCT_ROWS).all();
  res.render('admin/dashboard', {
    title: 'Tổng quan',
    stats: {
      newOrders: count("status = 'new'"),
      inProgress: count("status IN ('confirmed', 'shipping')"),
      doneRevenue: sum("status = 'done'"),
      openRevenue: sum("status IN ('new', 'confirmed', 'shipping')"),
      products: products.length,
      soldOut: products.filter((p) => !p.stock_total).length,
      units: products.reduce((n, p) => n + p.stock_total, 0),
    },
    recent: db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 6').all(),
    lowStock: products.sort((a, b) => a.stock_total - b.stock_total).slice(0, 8),
  });
});

// Đơn hàng
router.get('/don-hang', (req, res) => {
  const status = Object.hasOwn(ORDER_STATUS, req.query.status) ? req.query.status : '';
  const sql = `
    SELECT o.*, (SELECT COALESCE(SUM(qty), 0) FROM order_items i WHERE i.order_id = o.id) AS item_count
    FROM orders o ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 300`;
  const orders = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  const counts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all().map((r) => [r.status, r.n]));
  res.render('admin/orders', { title: 'Đơn hàng', orders, status, counts });
});

const getOrder = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));

router.get('/don-hang/:id(\\d+)', (req, res, next) => {
  const order = getOrder(req.params.id);
  if (!order) return next();
  const items = db.prepare(`
    SELECT i.*, p.code, p.slug FROM order_items i LEFT JOIN products p ON p.id = i.product_id
    WHERE i.order_id = ? ORDER BY i.id`).all(order.id);
  res.render('admin/order', { title: `Đơn ${orderCode(order.id)}`, order, items });
});

router.post('/don-hang/:id(\\d+)/trang-thai', (req, res, next) => {
  const order = getOrder(req.params.id);
  if (!order) return next();
  const status = req.body.status;
  // Đơn đã huỷ thì giữ nguyên: hàng đã trả về kho. Huỷ đơn đi qua nút riêng bên dưới.
  if (order.status !== 'cancelled' && Object.hasOwn(ORDER_STATUS, status) && status !== 'cancelled') {
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
  }
  res.redirect(`/admin/don-hang/${order.id}`);
});

router.post('/don-hang/:id(\\d+)/huy', (req, res, next) => {
  const order = getOrder(req.params.id);
  if (!order) return next();
  cancelOrder(order.id);
  res.redirect(`/admin/don-hang/${order.id}`);
});

router.post('/don-hang/:id(\\d+)/da-thanh-toan', (req, res, next) => {
  const order = getOrder(req.params.id);
  if (!order) return next();
  markPaid(order.id);
  res.redirect(`/admin/don-hang/${order.id}`);
});

// Kho sản phẩm
router.get('/san-pham', (req, res) => {
  const q = text(req.query.q).slice(0, 80);
  let products = db.prepare(`${PRODUCT_ROWS} ORDER BY p.id DESC`).all();
  if (q) products = products.filter((p) => fold(`${p.name} ${p.code || ''}`).includes(fold(q)));
  res.render('admin/products', { title: 'Kho sản phẩm', products, q });
});

// Đọc và kiểm tra các ô chung của form sản phẩm
function readProductForm(body, category) {
  const errors = {};
  const cost = text(body.cost) === '' ? null : int(body.cost);
  const hasSize = body.has_size === '1';
  const values = {
    name: text(body.name),
    badge: text(body.badge).slice(0, 30) || null,
    description: text(body.description).slice(0, 1000) || null,
    cost,
    // có giá sỉ thì giá bán tính theo pricing.js, không thì dùng giá nhập tay
    price: cost !== null ? retailPrice(category, cost) : int(body.price),
    size_min: hasSize ? int(body.size_min) : 0,
    size_max: hasSize ? int(body.size_max) : 0,
  };
  if (!values.name || values.name.length > 150) errors.name = 'Vui lòng nhập tên sản phẩm.';
  if (text(body.cost) !== '' && cost === null) errors.cost = 'Giá sỉ phải là số, tính bằng đồng.';
  if (values.price === null) errors.price = 'Nhập giá sỉ hoặc giá bán.';
  if (hasSize && !(values.size_min >= 30 && values.size_max <= 46 && values.size_min <= values.size_max)) {
    errors.size = 'Size từ 30 đến 46, size nhỏ nhất không lớn hơn size lớn nhất.';
  }
  return { values, errors };
}

router.get('/san-pham/moi', (req, res) => {
  res.render('admin/product-new', { title: 'Thêm sản phẩm', values: { has_size: '1', size_min: 35, size_max: 39 }, errors: {} });
});

router.post('/san-pham/moi', (req, res) => {
  const code = text(req.body.code);
  const category = Object.hasOwn(CATEGORIES, req.body.category) ? req.body.category : '';
  const { values, errors } = readProductForm(req.body, category || 'sneaker');
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(code)) errors.code = 'Mã gồm 2–30 ký tự: chữ, số, - hoặc _.';
  else if (db.prepare('SELECT 1 FROM products WHERE code = ?').get(code)) errors.code = 'Mã này đã có sản phẩm khác dùng.';
  if (!category) errors.category = 'Vui lòng chọn danh mục.';
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/product-new', { title: 'Thêm sản phẩm', values: { ...req.body, code }, errors });
  }

  const slug = `${fold(values.name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${code.toLowerCase()}`;
  const id = Number(db.prepare(`
    INSERT INTO products (slug, code, name, category, badge, cost, price, size_min, size_max, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, code, values.name, category, values.badge, values.cost, values.price,
    values.size_min, values.size_max, values.description).lastInsertRowid);
  syncProductMedia(getProduct(id), { createFolder: true });
  res.redirect(`/admin/san-pham/${id}?ok=1`);
});

function renderProduct(res, product, { errors = {}, status = 200, saved = false } = {}) {
  const colors = colorsOf(product.id);
  res.status(status).render('admin/product', {
    title: product.name,
    product,
    colors,
    sizes: sizesOf(product),
    stock: stockMap(product, colors),
    folder: product.code ? path.join('public', 'uploads', product.category, product.code) : '',
    media: db.prepare("SELECT url, kind FROM product_images WHERE product_id = ? ORDER BY (kind = 'video') DESC, sort, id").all(product.id),
    errors,
    saved,
  });
}

router.get('/san-pham/:id(\\d+)', (req, res, next) => {
  const product = getProduct(req.params.id);
  if (!product) return next();
  renderProduct(res, product, { saved: req.query.ok === '1' });
});

// Lưu thông tin và số lượng tồn kho
router.post('/san-pham/:id(\\d+)', (req, res, next) => {
  const product = getProduct(req.params.id);
  if (!product) return next();
  const { values, errors } = readProductForm(req.body, product.category);
  if (Object.keys(errors).length) {
    return renderProduct(res, { ...product, ...req.body, cost: text(req.body.cost) }, { errors, status: 400 });
  }
  db.prepare(`
    UPDATE products SET name = ?, badge = ?, description = ?, cost = ?, price = ?, size_min = ?, size_max = ?
    WHERE id = ?
  `).run(values.name, values.badge, values.description, values.cost, values.price,
    values.size_min, values.size_max, product.id);

  const updated = getProduct(product.id);
  for (const v of variantsOf(updated)) {
    const qty = int(req.body[`stock_${v.colorId}_${v.size}`]);
    if (qty !== null) setStock(updated.id, v.colorId, v.size, Math.min(qty, 9999));
  }
  res.redirect(`/admin/san-pham/${product.id}?ok=1`);
});

router.post('/san-pham/:id(\\d+)/mau', (req, res, next) => {
  const product = getProduct(req.params.id);
  if (!product) return next();
  const name = text(req.body.name).slice(0, 40);
  const hex = /^#[0-9a-fA-F]{6}$/.test(req.body.hex) ? req.body.hex : '#111111';
  if (name) {
    const sort = db.prepare('SELECT COUNT(*) AS n FROM product_colors WHERE product_id = ?').get(product.id).n;
    // Sản phẩm chưa có màu thì tồn kho đang ghi ở "màu 0": bỏ đi, từ giờ tính theo từng màu
    if (sort === 0) db.prepare('DELETE FROM stock WHERE product_id = ? AND color_id = 0').run(product.id);
    db.prepare('INSERT INTO product_colors (product_id, name, hex, sole_hex, sort) VALUES (?, ?, ?, ?, ?)')
      .run(product.id, name, hex, hex, sort);
  }
  res.redirect(`/admin/san-pham/${product.id}`);
});

router.post('/san-pham/:id(\\d+)/mau/:colorId(\\d+)/xoa', (req, res, next) => {
  const product = getProduct(req.params.id);
  if (!product) return next();
  const colorId = Number(req.params.colorId);
  db.prepare('DELETE FROM product_colors WHERE id = ? AND product_id = ?').run(colorId, product.id);
  db.prepare('DELETE FROM stock WHERE product_id = ? AND color_id = ?').run(product.id, colorId);
  db.prepare('UPDATE product_images SET color_id = NULL WHERE product_id = ? AND color_id = ?').run(product.id, colorId);
  res.redirect(`/admin/san-pham/${product.id}`);
});

// Tải ảnh / video lên thư mục của sản phẩm. Trình duyệt gửi từng file dạng nhị phân,
// tên file nằm trong ?ten=..., nên không cần thư viện đọc form nhiều phần.
const UPLOAD_TYPES = { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.mp4': 'video', '.webm': 'video' };
const folderOf = (product) => path.join(__dirname, 'public', 'uploads', product.category, product.code);
const safeName = (name) => {
  const ext = path.extname(String(name || '')).toLowerCase();
  const base = fold(path.basename(String(name || ''), path.extname(String(name || ''))))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';
  return UPLOAD_TYPES[ext] ? base + ext : '';
};

router.post('/san-pham/:id(\\d+)/tai-len',
  express.raw({ type: () => true, limit: '300mb' }),
  (req, res, next) => {
    const product = getProduct(req.params.id);
    if (!product) return next();
    if (!product.code) return res.status(400).json({ error: 'Sản phẩm chưa có mã nên chưa có thư mục.' });
    let name = safeName(req.query.ten);
    if (!name) return res.status(400).json({ error: 'Chỉ nhận ảnh .jpg .png .webp hoặc video .mp4 .webm.' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'File rỗng.' });
    // gắn với màu: thêm tên màu không dấu vào đầu tên file
    const color = colorsOf(product.id).find((c) => c.id === Number(req.query.mau));
    if (color) name = fold(color.name).replace(/\s+/g, '') + '-' + name;
    const dir = folderOf(product);
    fs.mkdirSync(dir, { recursive: true });
    // trùng tên thì thêm số phía sau, không ghi đè file cũ
    let final = name;
    for (let i = 2; fs.existsSync(path.join(dir, final)); i++) final = name.replace(/(\.[a-z0-9]+)$/, `-${i}$1`);
    fs.writeFileSync(path.join(dir, final), req.body);
    syncProductMedia(getProduct(product.id), { createFolder: true });
    res.json({ ok: true, file: final });
  });

router.post('/san-pham/:id(\\d+)/xoa-file', (req, res, next) => {
  const product = getProduct(req.params.id);
  if (!product || !product.code) return next();
  const name = path.basename(String(req.body.file || ''));
  const file = path.join(folderOf(product), name);
  if (UPLOAD_TYPES[path.extname(name).toLowerCase()] && fs.existsSync(file)) fs.unlinkSync(file);
  syncProductMedia(getProduct(product.id));
  res.redirect(`/admin/san-pham/${product.id}#anh`);
});

router.use((req, res) => {
  res.status(404).render('admin/message', { title: 'Không tìm thấy', message: 'Trang quản trị này không tồn tại.' });
});

module.exports = router;
