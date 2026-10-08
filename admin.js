// Trang quản trị (/admin): đơn hàng và kho sản phẩm.
// Đăng nhập bằng mật khẩu ADMIN_PASSWORD trong file .env; chưa đặt mật khẩu thì trang quản trị tắt.
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const db = require('./db');
const { fold } = require('./text');
const { retailPrice } = require('./pricing');
const { CATEGORIES, CODE_PREFIXES, nextCode, sizesOf, colorsOf, variantsOf, stockMap, setStock } = require('./catalog');
const { ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, orderCode, cancelOrder, markPaid } = require('./orders');
const { syncProductMedia, prefixOf } = require('./media');
const storage = require('./storage');
const { saveSite } = require('./site');
const ah = require('./async-handler');

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
    (SELECT COALESCE(SUM(qty), 0) FROM stock s WHERE s.product_id = p.id)::int AS stock_total,
    (SELECT COUNT(*) FROM product_images i WHERE i.product_id = p.id)::int AS media_count
  FROM products p`;
const getProduct = (id) => db.one(`${PRODUCT_ROWS} WHERE p.id = ?`, [Number(id)]);

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.locals.admin = {
    statuses: ORDER_STATUS, methods: PAYMENT_METHOD, payments: PAYMENT_STATUS,
    categories: CATEGORIES, codePrefixes: CODE_PREFIXES, orderCode, section: req.path.split('/')[1] || '',
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
router.get('/', ah(async (req, res) => {
  const one = async (sql, ...args) => (await db.one(sql, args)).n;
  // ngày theo giờ Việt Nam (created_at lưu giờ UTC). Dùng to_char trả về text "YYYY-MM-DD"
  // thẳng, tránh pg parse ra Date object rồi lệch ngày theo timezone của máy chạy Node.
  const VN = "to_char(created_at + interval '7 hours', 'YYYY-MM-DD')";
  const today = "to_char((now() AT TIME ZONE 'utc') + interval '7 hours', 'YYYY-MM-DD')";
  const sold = "status != 'cancelled'";
  const products = await db.query(PRODUCT_ROWS);

  // doanh thu 7 ngày gần nhất, kể cả ngày không có đơn
  const weekRows = await db.query(`
    SELECT ${VN} AS day, COALESCE(SUM(total), 0)::int AS revenue, COUNT(*)::int AS orders
    FROM orders WHERE ${sold} AND ${VN} >= to_char((now() AT TIME ZONE 'utc') + interval '7 hours' - interval '6 days', 'YYYY-MM-DD')
    GROUP BY day`);
  const rows = new Map(weekRows.map((r) => [r.day, r]));
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() + 7 * 3600 * 1000 - i * 86400 * 1000).toISOString().slice(0, 10);
    const r = rows.get(d) || { revenue: 0, orders: 0 };
    week.push({ day: d, label: `${d.slice(8, 10)}/${d.slice(5, 7)}`, revenue: r.revenue, orders: r.orders });
  }

  res.render('admin/dashboard', {
    title: 'Tổng quan',
    todo: {
      newOrders: await one("SELECT COUNT(*)::int AS n FROM orders WHERE status = 'new'"),
      shipping: await one("SELECT COUNT(*)::int AS n FROM orders WHERE status IN ('confirmed', 'shipping')"),
      refund: await one("SELECT COUNT(*)::int AS n FROM orders WHERE status = 'cancelled' AND payment_status = 'paid'"),
      soldOut: products.filter((p) => !p.stock_total).length,
      noPhoto: products.filter((p) => !p.media_count).length,
    },
    stats: {
      todayRevenue: await one(`SELECT COALESCE(SUM(total), 0)::int AS n FROM orders WHERE ${sold} AND ${VN} = ${today}`),
      todayOrders: await one(`SELECT COUNT(*)::int AS n FROM orders WHERE ${sold} AND ${VN} = ${today}`),
      monthRevenue: await one(`SELECT COALESCE(SUM(total), 0)::int AS n FROM orders WHERE ${sold} AND to_char(created_at + interval '7 hours', 'YYYY-MM') = to_char((now() AT TIME ZONE 'utc') + interval '7 hours', 'YYYY-MM')`),
      monthOrders: await one(`SELECT COUNT(*)::int AS n FROM orders WHERE ${sold} AND to_char(created_at + interval '7 hours', 'YYYY-MM') = to_char((now() AT TIME ZONE 'utc') + interval '7 hours', 'YYYY-MM')`),
      products: products.length,
      units: products.reduce((n, p) => n + p.stock_total, 0),
    },
    week,
    weekMax: Math.max(...week.map((d) => d.revenue), 1),
    recent: await db.query('SELECT * FROM orders ORDER BY id DESC LIMIT 5'),
    lowStock: products.filter((p) => p.stock_total <= 5).sort((x, y) => x.stock_total - y.stock_total).slice(0, 6),
  });
}));

// Đơn hàng
router.get('/don-hang', ah(async (req, res) => {
  const status = Object.hasOwn(ORDER_STATUS, req.query.status) ? req.query.status : '';
  const sql = `
    SELECT o.*, (SELECT COALESCE(SUM(qty), 0) FROM order_items i WHERE i.order_id = o.id)::int AS item_count
    FROM orders o ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 300`;
  const orders = status ? await db.query(sql, [status]) : await db.query(sql);
  const counts = Object.fromEntries(
    (await db.query('SELECT status, COUNT(*)::int AS n FROM orders GROUP BY status')).map((r) => [r.status, r.n]));
  res.render('admin/orders', { title: 'Đơn hàng', orders, status, counts });
}));

const getOrder = (id) => db.one('SELECT * FROM orders WHERE id = ?', [Number(id)]);

router.get('/don-hang/:id(\\d+)', ah(async (req, res, next) => {
  const order = await getOrder(req.params.id);
  if (!order) return next();
  const items = await db.query(`
    SELECT i.*, p.code, p.slug FROM order_items i LEFT JOIN products p ON p.id = i.product_id
    WHERE i.order_id = ? ORDER BY i.id`, [order.id]);
  res.render('admin/order', { title: `Đơn ${orderCode(order.id)}`, order, items });
}));

router.post('/don-hang/:id(\\d+)/trang-thai', ah(async (req, res, next) => {
  const order = await getOrder(req.params.id);
  if (!order) return next();
  const status = req.body.status;
  // Đơn đã huỷ thì giữ nguyên: hàng đã trả về kho. Huỷ đơn đi qua nút riêng bên dưới.
  if (order.status !== 'cancelled' && Object.hasOwn(ORDER_STATUS, status) && status !== 'cancelled') {
    await db.run('UPDATE orders SET status = ? WHERE id = ?', [status, order.id]);
  }
  res.redirect(`/admin/don-hang/${order.id}`);
}));

router.post('/don-hang/:id(\\d+)/huy', ah(async (req, res, next) => {
  const order = await getOrder(req.params.id);
  if (!order) return next();
  await cancelOrder(order.id);
  res.redirect(`/admin/don-hang/${order.id}`);
}));

router.post('/don-hang/:id(\\d+)/da-thanh-toan', ah(async (req, res, next) => {
  const order = await getOrder(req.params.id);
  if (!order) return next();
  await markPaid(order.id);
  res.redirect(`/admin/don-hang/${order.id}`);
}));

// Kho sản phẩm
router.get('/san-pham', ah(async (req, res) => {
  const q = text(req.query.q).slice(0, 80);
  let products = await db.query(`${PRODUCT_ROWS} ORDER BY p.id DESC`);
  if (q) products = products.filter((p) => fold(`${p.name} ${p.code || ''}`).includes(fold(q)));
  res.render('admin/products', { title: 'Kho sản phẩm', products, q });
}));

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

router.post('/san-pham/moi', ah(async (req, res) => {
  const category = Object.hasOwn(CATEGORIES, req.body.category) ? req.body.category : '';
  const { values, errors } = readProductForm(req.body, category || 'sneaker');
  if (!category) errors.category = 'Vui lòng chọn danh mục.';
  if (Object.keys(errors).length) {
    return res.status(400).render('admin/product-new', { title: 'Thêm sản phẩm', values: req.body, errors });
  }

  const code = await nextCode(db, category);
  const slug = `${fold(values.name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${code.toLowerCase()}`;
  const { id } = await db.one(`
    INSERT INTO products (slug, code, name, category, badge, cost, price, size_min, size_max, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [slug, code, values.name, category, values.badge, values.cost, values.price, values.size_min, values.size_max, values.description]);
  res.redirect(`/admin/san-pham/${id}?ok=1`);
}));

async function renderProduct(res, product, { errors = {}, status = 200, saved = false } = {}) {
  const colors = await colorsOf(db, product.id);
  res.status(status).render('admin/product', {
    title: product.name,
    product,
    colors,
    sizes: sizesOf(product),
    stock: await stockMap(db, product, colors),
    folder: product.code ? prefixOf(product) : '',
    media: await db.query("SELECT url, kind FROM product_images WHERE product_id = ? ORDER BY (kind = 'video') DESC, sort, id", [product.id]),
    errors,
    saved,
  });
}

router.get('/san-pham/:id(\\d+)', ah(async (req, res, next) => {
  const product = await getProduct(req.params.id);
  if (!product) return next();
  await renderProduct(res, product, { saved: req.query.ok === '1' });
}));

// Lưu thông tin và số lượng tồn kho
router.post('/san-pham/:id(\\d+)', ah(async (req, res, next) => {
  const product = await getProduct(req.params.id);
  if (!product) return next();
  const { values, errors } = readProductForm(req.body, product.category);
  if (Object.keys(errors).length) {
    return renderProduct(res, { ...product, ...req.body, cost: text(req.body.cost) }, { errors, status: 400 });
  }
  await db.run(`
    UPDATE products SET name = ?, badge = ?, description = ?, cost = ?, price = ?, size_min = ?, size_max = ?
    WHERE id = ?
  `, [values.name, values.badge, values.description, values.cost, values.price, values.size_min, values.size_max, product.id]);

  const updated = await getProduct(product.id);
  for (const v of await variantsOf(db, updated)) {
    const qty = int(req.body[`stock_${v.colorId}_${v.size}`]);
    if (qty !== null) await setStock(db, updated.id, v.colorId, v.size, Math.min(qty, 9999));
  }
  res.redirect(`/admin/san-pham/${product.id}?ok=1`);
}));

router.post('/san-pham/:id(\\d+)/mau', ah(async (req, res, next) => {
  const product = await getProduct(req.params.id);
  if (!product) return next();
  const name = text(req.body.name).slice(0, 40);
  const hex = /^#[0-9a-fA-F]{6}$/.test(req.body.hex) ? req.body.hex : '#111111';
  if (name) {
    const sort = (await db.one('SELECT COUNT(*)::int AS n FROM product_colors WHERE product_id = ?', [product.id])).n;
    // Sản phẩm chưa có màu thì tồn kho đang ghi ở "màu 0": bỏ đi, từ giờ tính theo từng màu
    if (sort === 0) await db.run('DELETE FROM stock WHERE product_id = ? AND color_id = 0', [product.id]);
    await db.run('INSERT INTO product_colors (product_id, name, hex, sole_hex, sort) VALUES (?, ?, ?, ?, ?)',
      [product.id, name, hex, hex, sort]);
  }
  res.redirect(`/admin/san-pham/${product.id}`);
}));

router.post('/san-pham/:id(\\d+)/mau/:colorId(\\d+)/xoa', ah(async (req, res, next) => {
  const product = await getProduct(req.params.id);
  if (!product) return next();
  const colorId = Number(req.params.colorId);
  await db.run('DELETE FROM product_colors WHERE id = ? AND product_id = ?', [colorId, product.id]);
  await db.run('DELETE FROM stock WHERE product_id = ? AND color_id = ?', [product.id, colorId]);
  await db.run('UPDATE product_images SET color_id = NULL WHERE product_id = ? AND color_id = ?', [product.id, colorId]);
  res.redirect(`/admin/san-pham/${product.id}`);
}));

// Tải ảnh / video lên bucket Storage của sản phẩm. Trình duyệt gửi từng file dạng nhị phân,
// tên file nằm trong ?ten=..., nên không cần thư viện đọc form nhiều phần.
const UPLOAD_TYPES = { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.mp4': 'video', '.webm': 'video', '.mov': 'video' };
const safeName = (name) => {
  const ext = path.extname(String(name || '')).toLowerCase();
  const base = fold(path.basename(String(name || ''), path.extname(String(name || ''))))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';
  return UPLOAD_TYPES[ext] ? base + ext : '';
};

router.post('/san-pham/:id(\\d+)/tai-len',
  express.raw({ type: () => true, limit: '300mb' }),
  ah(async (req, res, next) => {
    const product = await getProduct(req.params.id);
    if (!product) return next();
    if (!product.code) return res.status(400).json({ error: 'Sản phẩm chưa có mã nên chưa có thư mục.' });
    let name = safeName(req.query.ten);
    if (!name) return res.status(400).json({ error: 'Chỉ nhận ảnh .jpg .png .webp hoặc video .mp4 .webm .mov.' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'File rỗng.' });
    // gắn với màu: thêm tên màu không dấu vào đầu tên file
    const color = (await colorsOf(db, product.id)).find((c) => c.id === Number(req.query.mau));
    if (color) name = fold(color.name).replace(/\s+/g, '') + '-' + name;
    const prefix = prefixOf(product);
    // trùng tên thì thêm số phía sau, không ghi đè file cũ
    const existing = new Set(await storage.list(prefix));
    let final = name;
    for (let i = 2; existing.has(final); i++) final = name.replace(/(\.[a-z0-9]+)$/, `-${i}$1`);
    await storage.upload(prefix + final, req.body);
    await syncProductMedia(await getProduct(product.id));
    res.json({ ok: true, file: final });
  }));

router.post('/san-pham/:id(\\d+)/xoa-file', ah(async (req, res, next) => {
  const product = await getProduct(req.params.id);
  if (!product || !product.code) return next();
  const name = path.basename(String(req.body.file || ''));
  if (UPLOAD_TYPES[path.extname(name).toLowerCase()]) await storage.remove([prefixOf(product) + name]);
  await syncProductMedia(await getProduct(product.id));
  res.redirect(`/admin/san-pham/${product.id}#anh`);
}));

// Thông tin website: liên hệ của shop và danh sách cửa hàng
async function renderSite(res, { values, errors = {}, status = 200, saved = false } = {}) {
  res.status(status).render('admin/site', {
    title: 'Thông tin website',
    values: values || res.locals.site,
    stores: await db.query('SELECT * FROM stores ORDER BY id'),
    errors,
    saved,
  });
}

router.get('/thong-tin', ah(async (req, res) => {
  await renderSite(res, { saved: req.query.ok === '1' });
}));

router.post('/thong-tin', ah(async (req, res) => {
  const values = {
    name: text(req.body.name).slice(0, 60),
    email: text(req.body.email).slice(0, 120),
    phone: text(req.body.phone).slice(0, 30),
  };
  const errors = {};
  if (!values.name) errors.name = 'Vui lòng nhập tên shop.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Email chưa đúng.';
  if (!/\d/.test(values.phone)) errors.phone = 'Vui lòng nhập số điện thoại.';
  if (Object.keys(errors).length) return renderSite(res, { values, errors, status: 400 });
  await saveSite(values);
  res.redirect('/admin/thong-tin?ok=1');
}));

// Đọc form một cửa hàng; thiếu tên, địa chỉ hoặc tỉnh thành thì trả về null
function readStoreForm(body) {
  const store = {
    name: text(body.name).slice(0, 100),
    address: text(body.address).slice(0, 200),
    city: text(body.city).slice(0, 60),
    phone: text(body.phone).slice(0, 30) || null,
    hours: text(body.hours).slice(0, 100) || null,
  };
  return store.name && store.address && store.city ? store : null;
}

router.post('/thong-tin/cua-hang', ah(async (req, res) => {
  const s = readStoreForm(req.body);
  if (s) {
    await db.run('INSERT INTO stores (name, address, city, phone, hours) VALUES (?, ?, ?, ?, ?)',
      [s.name, s.address, s.city, s.phone, s.hours]);
  }
  res.redirect(`/admin/thong-tin${s ? '?ok=1' : ''}#cua-hang`);
}));

router.post('/thong-tin/cua-hang/:id(\\d+)', ah(async (req, res) => {
  const s = readStoreForm(req.body);
  if (s) {
    await db.run('UPDATE stores SET name = ?, address = ?, city = ?, phone = ?, hours = ? WHERE id = ?',
      [s.name, s.address, s.city, s.phone, s.hours, Number(req.params.id)]);
  }
  res.redirect(`/admin/thong-tin${s ? '?ok=1' : ''}#cua-hang`);
}));

router.post('/thong-tin/cua-hang/:id(\\d+)/xoa', ah(async (req, res) => {
  await db.run('DELETE FROM stores WHERE id = ?', [Number(req.params.id)]);
  res.redirect('/admin/thong-tin?ok=1#cua-hang');
}));

router.use((req, res) => {
  res.status(404).render('admin/message', { title: 'Không tìm thấy', message: 'Trang quản trị này không tồn tại.' });
});

module.exports = router;
