// Trang quản trị (/admin): đơn hàng và kho sản phẩm.
// Đăng nhập bằng mật khẩu ADMIN_PASSWORD trong file .env; chưa đặt mật khẩu thì trang quản trị tắt.
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const db = require('./db');
const { fold } = require('./text');
const { retailPrice } = require('./pricing');
const { CATEGORIES, GROUPS, CODE_PREFIXES, nextCode, sizesOf, colorsOf, variantsOf, stockMap, setStock } = require('./catalog');
const { ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, orderCode, cancelOrder, markPaid } = require('./orders');
const { syncProductMedia, prefixOf } = require('./media');
const storage = require('./storage');
const { saveSite } = require('./site');
const { BANKS, transferQr } = require('./vietqr');
const { sourceLabel, SEARCH_ENGINES } = require('./tracking');
const { hashPassword } = require('./customers');
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
    (SELECT COUNT(*) FROM product_images i WHERE i.product_id = p.id)::int AS media_count,
    (SELECT COUNT(*) FROM visits v WHERE v.product_id = p.id)::int AS view_count,
    (SELECT COUNT(*) FROM favorites f WHERE f.product_id = p.id)::int AS fav_count,
    (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id)::int AS review_count,
    (SELECT COUNT(*) FROM order_items o WHERE o.product_id = p.id)::int AS order_count
  FROM products p`;
const getProduct = (id) => db.one(`${PRODUCT_ROWS} WHERE p.id = ?`, [Number(id)]);

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.locals.admin = {
    statuses: ORDER_STATUS, methods: PAYMENT_METHOD, payments: PAYMENT_STATUS,
    categories: CATEGORIES, groups: GROUPS, banks: BANKS, codePrefixes: CODE_PREFIXES, orderCode, sourceLabel, section: req.path.split('/')[1] || '',
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
      messages: await one('SELECT COUNT(*)::int AS n FROM messages WHERE NOT done'),
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
      todayVisitors: await one(`SELECT COUNT(DISTINCT visitor)::int AS n FROM visits WHERE ${VN} = ${today}`),
      todayViews: await one(`SELECT COUNT(*)::int AS n FROM visits WHERE ${VN} = ${today}`),
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

// Bill để in kèm hàng. Đơn chưa thu tiền thì có mã QR chuyển khoản (số tiền và mã đơn điền sẵn).
router.get('/don-hang/:id(\\d+)/in', ah(async (req, res, next) => {
  const order = await getOrder(req.params.id);
  if (!order) return next();
  res.render('admin/bill', {
    title: `Bill ${orderCode(order.id)}`,
    order,
    items: await db.query(`
      SELECT i.*, p.code FROM order_items i LEFT JOIN products p ON p.id = i.product_id
      WHERE i.order_id = ? ORDER BY i.id`, [order.id]),
    stores: await db.query('SELECT * FROM stores ORDER BY id LIMIT 1'),
    transfer: order.payment_status === 'paid' ? null : await transferQr(res.locals.site, order.total, orderCode(order.id)),
  });
}));

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
  // khớp khi tên hoặc mã có đủ mọi từ đã gõ, giống cách lọc ngay trên trang
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (words.length) products = products.filter((p) => words.every((w) => fold(`${p.name} ${p.code || ''}`).includes(w)));
  res.render('admin/products', { title: 'Kho sản phẩm', products, q, deleted: req.query.xoa === '1' });
}));

// Đọc và kiểm tra các ô chung của form sản phẩm
function readProductForm(body, category) {
  const errors = {};
  const cost = text(body.cost) === '' ? null : int(body.cost);
  // Size chữ (quần áo): có thì size ghi bằng số thứ tự 1..n của các tên này
  const labels = text(body.size_labels).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const hasSize = body.has_size === '1' || labels.length > 0;
  const values = {
    name: text(body.name),
    badge: text(body.badge).slice(0, 30) || null,
    description: text(body.description).slice(0, 1000) || null,
    cost,
    // có giá sỉ thì giá bán tính theo pricing.js, không thì dùng giá nhập tay
    price: cost !== null ? retailPrice(category, cost) : int(body.price),
    size_min: labels.length ? 1 : hasSize ? int(body.size_min) : 0,
    size_max: labels.length || (hasSize ? int(body.size_max) : 0),
    size_labels: labels.join(',') || null,
  };
  if (!values.name || values.name.length > 150) errors.name = 'Vui lòng nhập tên sản phẩm.';
  if (text(body.cost) !== '' && cost === null) errors.cost = 'Giá sỉ phải là số, tính bằng đồng.';
  if (values.price === null) errors.price = 'Nhập giá sỉ hoặc giá bán.';
  if (labels.length > 12 || labels.some((s) => !/^[A-Z0-9]{1,10}$/.test(s))) {
    errors.size = 'Size chữ: tối đa 12 size, mỗi size chỉ gồm chữ và số, vd: M, L, XL, 3XL.';
  } else if (!labels.length && hasSize && !(values.size_min >= 30 && values.size_max <= 46 && values.size_min <= values.size_max)) {
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
    INSERT INTO products (slug, code, name, category, badge, cost, price, size_min, size_max, size_labels, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [slug, code, values.name, category, values.badge, values.cost, values.price, values.size_min, values.size_max, values.size_labels, values.description]);
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
    deleteBlocked: res.req.query.loi === 'co-don',
    reviews: await db.query(`
      SELECT r.id, r.rating, r.comment, r.created_at, c.name, c.phone
      FROM reviews r JOIN customers c ON c.id = r.customer_id WHERE r.product_id = ? ORDER BY r.id DESC`, [product.id]),
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
    UPDATE products SET name = ?, badge = ?, description = ?, cost = ?, price = ?, size_min = ?, size_max = ?, size_labels = ?
    WHERE id = ?
  `, [values.name, values.badge, values.description, values.cost, values.price, values.size_min, values.size_max, values.size_labels, product.id]);

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

// Ẩn / hiện lại sản phẩm trên trang bán hàng (dữ liệu, ảnh và tồn kho vẫn giữ nguyên)
router.post('/san-pham/:id(\\d+)/an', ah(async (req, res) => {
  await db.run('UPDATE products SET hidden = NOT hidden WHERE id = ?', [Number(req.params.id)]);
  res.redirect(`/admin/san-pham/${req.params.id}`);
}));

// Xoá hẳn sản phẩm cùng ảnh, màu, tồn kho. Sản phẩm đã có trong đơn hàng thì không xoá (chỉ ẩn được),
// để các đơn cũ vẫn mở ra xem lại được.
router.post('/san-pham/:id(\\d+)/xoa', ah(async (req, res, next) => {
  const product = await getProduct(req.params.id);
  if (!product) return next();
  if (product.order_count) return res.redirect(`/admin/san-pham/${product.id}?loi=co-don`);
  if (product.code) {
    const prefix = prefixOf(product);
    const files = await storage.list(prefix);
    if (files.length) await storage.remove(files.map((f) => prefix + f));
  }
  await db.withTransaction(async (tx) => {
    for (const table of ['product_images', 'stock', 'product_colors', 'favorites', 'reviews']) {
      await tx.run(`DELETE FROM ${table} WHERE product_id = ?`, [product.id]);
    }
    await tx.run('DELETE FROM product_links WHERE product_id = ? OR linked_id = ?', [product.id, product.id]);
    await tx.run('UPDATE visits SET product_id = NULL WHERE product_id = ?', [product.id]);
    await tx.run('DELETE FROM products WHERE id = ?', [product.id]);
  });
  res.redirect('/admin/san-pham?xoa=1');
}));

// Số đơn mới và tin nhắn chưa trả lời, cho huy hiệu trên menu và chuông báo đơn mới (views/admin/foot.ejs)
router.get('/dem', ah(async (req, res) => {
  const row = await db.one(`
    SELECT (SELECT COUNT(*) FROM orders WHERE status = 'new')::int AS orders,
      (SELECT COUNT(*) FROM messages WHERE NOT done)::int AS messages,
      (SELECT COALESCE(MAX(id), 0) FROM orders)::int AS last_order,
      (SELECT COALESCE(MAX(id), 0) FROM messages)::int AS last_message`);
  res.json(row);
}));

// Xoá một đánh giá không phù hợp
router.post('/san-pham/:id(\\d+)/danh-gia/:reviewId(\\d+)/xoa', ah(async (req, res) => {
  await db.run('DELETE FROM reviews WHERE id = ? AND product_id = ?', [Number(req.params.reviewId), Number(req.params.id)]);
  res.redirect(`/admin/san-pham/${req.params.id}#danh-gia`);
}));

// Lượt truy cập: bao nhiêu người vào web, đi từ kênh nào, xem sản phẩm nào
router.get('/truy-cap', ah(async (req, res) => {
  const days = [1, 7, 30, 90].includes(Number(req.query.ngay)) ? Number(req.query.ngay) : 7;
  // ngày theo giờ Việt Nam (created_at lưu giờ UTC)
  const VN = "to_char(created_at + interval '7 hours', 'YYYY-MM-DD')";
  const since = `${VN} >= to_char((now() AT TIME ZONE 'utc') + interval '7 hours' - interval '${days - 1} days', 'YYYY-MM-DD')`;

  const total = await db.one(`SELECT COUNT(*)::int AS views, COUNT(DISTINCT visitor)::int AS visitors FROM visits WHERE ${since}`);
  const orderRows = await db.query(`
    SELECT COALESCE(source, 'truc-tiep') AS source, COUNT(*)::int AS orders, COALESCE(SUM(total), 0)::int AS revenue
    FROM orders WHERE status != 'cancelled' AND ${since} GROUP BY 1`);
  const ordersBy = new Map(orderRows.map((r) => [r.source, r]));
  const sources = (await db.query(`
    SELECT source, COUNT(DISTINCT visitor)::int AS visitors, COUNT(*)::int AS views
    FROM visits WHERE ${since} GROUP BY source ORDER BY visitors DESC, views DESC`))
    .map((s) => ({ ...s, orders: 0, revenue: 0, ...ordersBy.get(s.source) }));
  // kênh có đơn nhưng không còn lượt xem nào trong khoảng này vẫn phải hiện
  for (const r of orderRows) {
    if (!sources.some((s) => s.source === r.source)) sources.push({ visitors: 0, views: 0, ...r });
  }

  const dayRows = new Map((await db.query(`
    SELECT ${VN} AS day, COUNT(DISTINCT visitor)::int AS visitors, COUNT(*)::int AS views
    FROM visits WHERE ${since} GROUP BY day`)).map((r) => [r.day, r]));
  const chartDays = Math.min(days === 1 ? 7 : days, 30);
  const chart = [];
  for (let i = chartDays - 1; i >= 0; i--) {
    const d = new Date(Date.now() + 7 * 3600 * 1000 - i * 86400 * 1000).toISOString().slice(0, 10);
    const r = dayRows.get(d) || { visitors: 0, views: 0 };
    chart.push({ label: `${d.slice(8, 10)}/${d.slice(5, 7)}`, visitors: r.visitors, views: r.views });
  }

  res.render('admin/visits', {
    title: 'Truy cập',
    days,
    total,
    orders: orderRows.reduce((n, r) => n + r.orders, 0),
    customers: (await db.one(`SELECT COUNT(*)::int AS n FROM customers WHERE ${since}`)).n,
    sources,
    chart: days === 1 ? [] : chart,
    chartMax: Math.max(...chart.map((d) => d.visitors), 1),
    products: await db.query(`
      SELECT p.id, p.code, p.name, COUNT(*)::int AS views, COUNT(DISTINCT v.visitor)::int AS visitors,
        (SELECT COUNT(*) FROM favorites f WHERE f.product_id = p.id)::int AS favs
      FROM visits v JOIN products p ON p.id = v.product_id
      WHERE ${since.replaceAll('created_at', 'v.created_at')} GROUP BY p.id ORDER BY views DESC LIMIT 15`),
    pages: await db.query(`
      SELECT path, COUNT(*)::int AS views, COUNT(DISTINCT visitor)::int AS visitors
      FROM visits WHERE product_id IS NULL AND ${since} GROUP BY path ORDER BY views DESC LIMIT 10`),
    referrers: await db.query(`
      SELECT referrer, COUNT(DISTINCT visitor)::int AS visitors FROM visits
      WHERE referrer IS NOT NULL AND ${since} GROUP BY referrer ORDER BY visitors DESC LIMIT 10`),
  });
}));

// SEO: khách tới từ công cụ tìm kiếm, vào trang nào đầu tiên, và gõ gì vào ô tìm kiếm của web.
// Từ khoá khách gõ trên Google thì Google không gửi cho web; phải xem ở Google Search Console.
router.get('/seo', ah(async (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.ngay)) ? Number(req.query.ngay) : 30;
  const VN = "to_char(created_at + interval '7 hours', 'YYYY-MM-DD')";
  const since = `${VN} >= to_char((now() AT TIME ZONE 'utc') + interval '7 hours' - interval '${days - 1} days', 'YYYY-MM-DD')`;
  const engines = SEARCH_ENGINES.map((e) => `'${e}'`).join(', ');

  const all = await db.one(`SELECT COUNT(DISTINCT visitor)::int AS visitors FROM visits WHERE ${since}`);
  const fromSearch = await db.one(`
    SELECT COUNT(DISTINCT visitor)::int AS visitors, COUNT(*)::int AS views FROM visits WHERE source IN (${engines}) AND ${since}`);
  const orders = await db.one(`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0)::int AS revenue
    FROM orders WHERE status != 'cancelled' AND source IN (${engines}) AND ${since}`);

  const dayRows = new Map((await db.query(`
    SELECT ${VN} AS day, COUNT(DISTINCT visitor)::int AS visitors
    FROM visits WHERE source IN (${engines}) AND ${since} GROUP BY day`)).map((r) => [r.day, r.visitors]));
  const chart = [];
  for (let i = Math.min(days, 30) - 1; i >= 0; i--) {
    const d = new Date(Date.now() + 7 * 3600 * 1000 - i * 86400 * 1000).toISOString().slice(0, 10);
    chart.push({ label: `${d.slice(8, 10)}/${d.slice(5, 7)}`, visitors: dayRows.get(d) || 0 });
  }

  const products = await db.query(PRODUCT_ROWS);
  res.render('admin/seo', {
    title: 'SEO',
    days,
    all,
    fromSearch,
    orders,
    chart,
    chartMax: Math.max(...chart.map((d) => d.visitors), 1),
    engines: await db.query(`
      SELECT source, COUNT(DISTINCT visitor)::int AS visitors, COUNT(*)::int AS views
      FROM visits WHERE source IN (${engines}) AND ${since} GROUP BY source ORDER BY visitors DESC`),
    // trang đầu tiên khách mở khi bấm từ kết quả tìm kiếm (dòng có ghi trang dẫn tới)
    landings: await db.query(`
      SELECT v.path, p.name, COUNT(*)::int AS visits FROM visits v LEFT JOIN products p ON p.id = v.product_id
      WHERE v.source IN (${engines}) AND v.referrer IS NOT NULL AND ${since.replaceAll('created_at', 'v.created_at')}
      GROUP BY v.path, p.name ORDER BY visits DESC LIMIT 15`),
    searches: await db.query(`
      SELECT query, COUNT(*)::int AS times, COUNT(DISTINCT visitor)::int AS people, MIN(results)::int AS results
      FROM searches WHERE ${since} GROUP BY query ORDER BY times DESC, query LIMIT 30`),
    checks: {
      description: res.locals.site.description,
      verified: Boolean(res.locals.site.google_verify),
      customDomain: !/onrender\.com$/.test(req.hostname) && req.hostname !== 'localhost',
      noDescription: products.filter((p) => !p.description),
      noPhoto: products.filter((p) => !p.media_count),
    },
    base: process.env.BASE_URL || `${req.protocol}://${req.get('host')}`,
  });
}));

// Tin nhắn khách gửi ở trang Liên hệ
router.get('/tin-nhan', ah(async (req, res) => {
  const showAll = req.query.xem === 'tat-ca';
  res.render('admin/messages', {
    title: 'Tin nhắn',
    showAll,
    waiting: (await db.one('SELECT COUNT(*)::int AS n FROM messages WHERE NOT done')).n,
    messages: await db.query(`SELECT * FROM messages ${showAll ? '' : 'WHERE NOT done'} ORDER BY id DESC LIMIT 200`),
  });
}));

router.post('/tin-nhan/:id(\\d+)', ah(async (req, res) => {
  await db.run('UPDATE messages SET done = ? WHERE id = ?', [req.body.done === '1', Number(req.params.id)]);
  res.redirect(`/admin/tin-nhan${req.body.xem === 'tat-ca' ? '?xem=tat-ca' : ''}`);
}));

// Khách hàng đã đăng ký tài khoản
router.get('/khach-hang', ah(async (req, res) => {
  const q = text(req.query.q).slice(0, 80);
  let customers = await db.query(`
    SELECT c.id, c.name, c.phone, c.address, c.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled')::int AS orders,
      (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled')::int AS spent
    FROM customers c ORDER BY c.id DESC LIMIT 500`);
  if (q) customers = customers.filter((c) => fold(`${c.name} ${c.phone} ${c.address || ''}`).includes(fold(q)));
  res.render('admin/customers', { title: 'Khách hàng', customers, q, reset: text(req.query.reset) });
}));

// Khách quên mật khẩu: đặt mật khẩu tạm rồi báo cho khách, khách tự đổi lại sau khi đăng nhập
router.post('/khach-hang/:id(\\d+)/mat-khau', ah(async (req, res) => {
  const password = text(req.body.password);
  if (password.length < 6 || password.length > 100) return res.redirect('/admin/khach-hang?reset=loi');
  await db.run('UPDATE customers SET password_hash = ? WHERE id = ?', [await hashPassword(password), Number(req.params.id)]);
  res.redirect('/admin/khach-hang?reset=ok');
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
  // Zalo: nhận số điện thoại hoặc link zalo.me. Messenger: nhận tên trang hoặc link m.me / facebook.com.
  const zalo = text(req.body.zalo).slice(0, 120);
  const zaloPhone = zalo.replace(/[\s.-]/g, '').replace(/^\+?84/, '0');
  const facebook = text(req.body.facebook).slice(0, 200);
  // Dán cả thẻ <meta ... content="..."> cũng được, chỉ lấy phần mã
  const verify = text(req.body.google_verify);
  const values = {
    name: text(req.body.name).slice(0, 60),
    email: text(req.body.email).slice(0, 120),
    phone: text(req.body.phone).slice(0, 30),
    description: text(req.body.description).slice(0, 200),
    zalo: /^0\d{9,10}$/.test(zaloPhone) ? `https://zalo.me/${zaloPhone}` : zalo,
    facebook: /^[A-Za-z0-9.]{3,60}$/.test(facebook) ? `https://m.me/${facebook}` : facebook,
    ship_fee: String(Math.min(int(req.body.ship_fee) || 0, 1000000)),
    ship_free_from: String(int(req.body.ship_free_from) || 0),
    bank_bin: Object.hasOwn(BANKS, req.body.bank_bin) ? req.body.bank_bin : '',
    bank_account: text(req.body.bank_account).replace(/[\s.-]/g, '').slice(0, 24),
    bank_holder: text(req.body.bank_holder).slice(0, 80),
    google_verify: (/content=["']([^"']+)["']/.exec(verify) || [null, verify])[1].slice(0, 120),
  };
  const errors = {};
  if (!values.name) errors.name = 'Vui lòng nhập tên shop.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Email chưa đúng.';
  if (!/\d/.test(values.phone)) errors.phone = 'Vui lòng nhập số điện thoại.';
  if (!values.description) errors.description = 'Vui lòng nhập câu giới thiệu.';
  if (values.bank_account && !/^[0-9A-Za-z]{4,24}$/.test(values.bank_account)) errors.bank = 'Số tài khoản chỉ gồm chữ và số.';
  else if (Boolean(values.bank_bin) !== Boolean(values.bank_account)) errors.bank = 'Chọn ngân hàng và nhập số tài khoản, hoặc để trống cả hai.';
  if (values.zalo && !/^https:\/\/(zalo\.me|chat\.zalo\.me|oa\.zalo\.me)\/[^\s"'<>]+$/.test(values.zalo)) {
    errors.zalo = 'Nhập số điện thoại Zalo của shop, hoặc link dạng https://zalo.me/...';
  }
  if (values.facebook && !/^https:\/\/(m\.me|www\.facebook\.com|facebook\.com|www\.messenger\.com)\/[^\s"'<>]+$/.test(values.facebook)) {
    errors.facebook = 'Nhập tên trang Facebook, hoặc link dạng https://m.me/...';
  }
  // Nhận cả hai cách xác minh của Google: mã trong thẻ meta, hoặc tên file dạng google<mã>.html
  if (values.google_verify && !/^[A-Za-z0-9_-]+(\.html)?$/.test(values.google_verify)) {
    errors.google_verify = 'Mã xác minh chưa đúng. Dán thẻ meta Google đưa cho, hoặc tên file dạng google….html.';
  }
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
