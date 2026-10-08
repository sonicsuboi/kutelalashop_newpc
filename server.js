const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
// config phải nạp trước: nó đọc file .env mà vnpay.js và admin.js cần
const { SITE } = require('./config');
const db = require('./db');
const supportPages = require('./content');
const { fold } = require('./text');
const { syncProductMedia, syncAllMedia } = require('./media');
const { CATEGORIES, sizesOf, colorsOf, stockMap, stockOf } = require('./catalog');
const { orderCode, orderIdFromCode, OutOfStockError, createOrder, cancelOrder, markPaid } = require('./orders');
const vnpay = require('./vnpay');
const admin = require('./admin');

const app = express();
const PORT = process.env.PORT || 3000;

const SORTS = {
  newest: { label: 'Mới nhất', sql: 'created_at DESC, p.id ASC' },
  price_asc: { label: 'Giá tăng dần', sql: 'price ASC' },
  price_desc: { label: 'Giá giảm dần', sql: 'price DESC' },
};

// Mọi truy vấn sản phẩm đều kèm số màu (đếm từ product_colors) và tổng số lượng còn trong kho
const PRODUCTS = `
  SELECT p.*,
    (SELECT COUNT(*) FROM product_colors c WHERE c.product_id = p.id) AS color_count,
    (SELECT COALESCE(SUM(qty), 0) FROM stock s WHERE s.product_id = p.id) AS stock_total
  FROM products p`;

// Ảnh nền trang chủ: bỏ ảnh tên hero.jpg (banner), story.jpg (khối "Về shop") hoặc
// store.jpg (ô "Thử giày tại cửa hàng") vào public/images là tự dùng; cũng nhận
// .jpeg / .png / .webp. Không có thì trả về fallback.
function findImage(name, fallback = null) {
  const ext = ['jpg', 'jpeg', 'png', 'webp'].find((e) =>
    fs.existsSync(path.join(__dirname, 'public', 'images', `${name}.${e}`)));
  return ext ? `/images/${name}.${ext}` : fallback;
}

const queryText = (value) => (typeof value === 'string' ? value.trim().slice(0, 80) : '');
const formText = (value) => (typeof value === 'string' ? value.trim() : '');

// Giỏ hàng lưu trong cookie của khách, dạng "id.màu.size.số-lượng~id.màu.size.số-lượng"
// (màu là id trong bảng product_colors, 0 nếu sản phẩm không có màu để chọn)
const MAX_QTY = 10;
const MAX_LINES = 30;
const cartKey = (item) => `${item.id}.${item.color}.${item.size}`;

function readCart(req) {
  const match = /(?:^|;\s*)cart=([^;]*)/.exec(req.headers.cookie || '');
  if (!match) return [];
  const items = [];
  for (const part of match[1].split('~').slice(0, MAX_LINES)) {
    const m = /^(\d{1,9})\.(\d{1,9})\.(\d{1,2})\.(\d{1,2})$/.exec(part);
    if (m) {
      items.push({ id: +m[1], color: +m[2], size: +m[3], qty: Math.min(Math.max(+m[4], 1), MAX_QTY) });
    }
  }
  return items;
}

function writeCart(res, items) {
  if (!items.length) return res.clearCookie('cart');
  res.cookie('cart', items.map((i) => `${cartKey(i)}.${i.qty}`).join('~'), {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
  });
}

// Ghép giỏ hàng với dữ liệu sản phẩm, bỏ qua dòng không còn hợp lệ
function cartLines(items) {
  const find = db.prepare(`${PRODUCTS} WHERE p.id = ?`);
  const lines = [];
  for (const item of items) {
    const product = find.get(item.id);
    if (!product) continue;
    const sizes = sizesOf(product);
    if (sizes.length ? !sizes.includes(item.size) : item.size !== 0) continue;
    const color = colorsOf(product.id).find((c) => c.id === item.color) || null;
    if (product.color_count && !color) continue;
    const colorId = color ? color.id : 0;
    lines.push({
      key: cartKey(item),
      // hình vẽ trong giỏ hiện đúng màu khách chọn
      product: color ? { ...product, color: color.hex, sole_color: color.sole_hex } : product,
      colorId,
      colorName: color ? color.name : '',
      size: item.size,
      qty: item.qty,
      left: stockOf(product.id, colorId, item.size),
      subtotal: product.price * item.qty,
    });
  }
  return lines;
}

function renderCart(req, res, { values = {}, errors = {}, status = 200 } = {}) {
  const lines = cartLines(readCart(req));
  res.status(status).render('cart', {
    title: 'Giỏ hàng',
    lines,
    total: lines.reduce((sum, line) => sum + line.subtotal, 0),
    values: { name: '', phone: '', address: '', note: '', payment: 'cod', ...values },
    errors,
    maxQty: MAX_QTY,
    cardPayment: vnpay.enabled,
  });
}

// Ghi nhận kết quả VNPay gửi về. Dùng chung cho trang khách quay về và lời gọi IPN,
// nên gọi nhiều lần cho cùng một đơn vẫn cho cùng kết quả.
function settleVnpay(query) {
  const result = vnpay.verify(query);
  if (!result.valid) return { code: '97', message: 'Invalid signature' };
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.orderId);
  if (!order || order.payment_method !== 'vnpay') return { code: '01', message: 'Order not found' };
  if (order.total !== result.amount) return { code: '04', message: 'Invalid amount' };
  if (order.payment_status !== 'unpaid') return { code: '02', message: 'Order already confirmed', order };
  // Khách đã trả tiền thì luôn ghi nhận, kể cả khi đơn đã bị huỷ, để còn biết mà hoàn tiền
  if (result.success) markPaid(order.id, result.ref);
  else cancelOrder(order.id, 'failed');
  return {
    code: '00',
    message: 'Confirm Success',
    order: db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id),
  };
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

app.use((req, res, next) => {
  res.locals.site = SITE;
  res.locals.shopName = SITE.name;
  // Chỉ hiện những danh mục đang có sản phẩm
  const counts = {};
  for (const row of db.prepare('SELECT category, COUNT(*) AS n FROM products GROUP BY category').all()) {
    counts[row.category] = row.n;
  }
  res.locals.categoryCounts = counts;
  res.locals.categories = Object.fromEntries(
    Object.entries(CATEGORIES).filter(([key]) => counts[key]));
  res.locals.supportPages = supportPages;
  res.locals.current = { q: '' };
  res.locals.cartCount = readCart(req).reduce((sum, item) => sum + item.qty, 0);
  res.locals.formatPrice = (vnd) =>
    String(vnd).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' đ';
  next();
});

// Trang quản trị: đơn hàng và kho sản phẩm
app.use('/admin', admin);

// Trang chủ
app.get('/', (req, res) => {
  const featured = db.prepare(`${PRODUCTS} ORDER BY created_at DESC, p.id ASC LIMIT 5`).all();
  res.render('home', {
    title: 'Trang chủ',
    featured,
    counts: res.locals.categoryCounts,
    heroImage: findImage('hero', '/images/hero.svg'),
    storyImage: findImage('story'),
    storeImage: findImage('store'),
    // Ảnh nền hiện khi rê chuột vào từng dòng danh mục: public/images/categories/<mã danh mục>.jpg
    categoryImages: Object.fromEntries(
      Object.keys(CATEGORIES).map((key) => [key, findImage(`categories/${key}`)])),
  });
});

// Danh sách sản phẩm
app.get('/san-pham', (req, res) => {
  const category = Object.hasOwn(CATEGORIES, req.query.loai) ? req.query.loai : '';
  const sort = Object.hasOwn(SORTS, req.query.sort) ? req.query.sort : 'newest';
  const q = queryText(req.query.q);

  let products = category
    ? db.prepare(`${PRODUCTS} WHERE category = ? ORDER BY ${SORTS[sort].sql}`).all(category)
    : db.prepare(`${PRODUCTS} ORDER BY ${SORTS[sort].sql}`).all();
  if (q) products = products.filter((p) => fold(p.name).includes(fold(q)));

  // Tạo link giữ nguyên các bộ lọc đang chọn, chỉ đổi phần truyền vào
  const link = (change) => {
    const next = { category, sort, q, ...change };
    const qs = new URLSearchParams();
    if (next.category) qs.set('loai', next.category);
    if (next.sort && next.sort !== 'newest') qs.set('sort', next.sort);
    if (next.q) qs.set('q', next.q);
    const s = qs.toString();
    return s ? '/san-pham?' + s : '/san-pham';
  };

  res.render('products', {
    title: category ? CATEGORIES[category] : 'Sản phẩm mới',
    products,
    sorts: SORTS,
    current: { category, sort, q },
    link,
  });
});

// Chi tiết sản phẩm
app.get('/san-pham/:slug', (req, res, next) => {
  const product = db.prepare(`${PRODUCTS} WHERE slug = ?`).get(req.params.slug);
  if (!product) return next();
  const related = db
    .prepare(`${PRODUCTS} WHERE p.id != ? ORDER BY (category = ?) DESC, p.id ASC LIMIT 4`)
    .all(product.id, product.category);

  // Ảnh và video ở trang chi tiết: quét lại thư mục của sản phẩm rồi đọc từ database,
  // nên chép file mới vào thư mục là hiện ngay
  syncProductMedia(product);
  const media = db
    // video luôn đứng đầu bộ hình, sau đó tới ảnh theo thứ tự tên file
    .prepare("SELECT url, kind, color_id FROM product_images WHERE product_id = ? ORDER BY (kind = 'video') DESC, sort, id")
    .all(product.id);
  if (!media.length && product.image_url) media.push({ url: product.image_url, kind: 'image', color_id: null });

  // Gợi ý mua kèm: lấy các sản phẩm đã gắn trong product_links; giày dép chưa gắn gì thì gợi ý kính
  let pairs = db
    .prepare(`${PRODUCTS} JOIN product_links l ON l.linked_id = p.id WHERE l.product_id = ? ORDER BY l.id`)
    .all(product.id);
  if (!pairs.length && product.category !== 'kinh') {
    pairs = db.prepare(`${PRODUCTS} WHERE category = 'kinh' ORDER BY created_at DESC, p.id DESC LIMIT 4`).all();
  }

  const colors = colorsOf(product.id);
  const stock = stockMap(product, colors);
  res.render('product', {
    title: product.name,
    product,
    related,
    media,
    pairs,
    colors,
    sizes: sizesOf(product),
    // số lượng còn theo từng 'màu.size'
    stock,
    stockTotal: Object.values(stock).reduce((sum, qty) => sum + qty, 0),
    needSize: req.query.loi === 'size',
    outOfStock: req.query.loi === 'het',
  });
});

// Dữ liệu cho hộp chọn nhanh màu / size ở trang danh sách (nút "Thêm vào giỏ" trên thẻ sản phẩm)
app.get('/san-pham/:slug/nhanh', (req, res, next) => {
  const product = db.prepare(`${PRODUCTS} WHERE slug = ?`).get(req.params.slug);
  if (!product) return next();
  const colors = colorsOf(product.id);
  res.json({
    id: product.id,
    slug: product.slug,
    name: product.name,
    price: res.locals.formatPrice(product.price),
    image: product.image_url,
    colors: colors.map((c) => ({ id: c.id, name: c.name, hex: c.hex })),
    sizes: sizesOf(product),
    stock: stockMap(product, colors),
  });
});

// Yêu thích: danh sách lưu trên trình duyệt, trang này trả về mọi sản phẩm rồi JS lọc lại
app.get('/yeu-thich', (req, res) => {
  const products = db.prepare(`${PRODUCTS} ORDER BY created_at DESC, p.id ASC`).all();
  res.render('favorites', { title: 'Yêu thích', products });
});

app.get('/gioi-thieu', (req, res) => {
  res.render('about', { title: 'Giới thiệu' });
});

// Hệ thống cửa hàng
app.get('/cua-hang', (req, res) => {
  const q = queryText(req.query.q);
  let stores = db.prepare('SELECT * FROM stores ORDER BY id').all();
  if (q) {
    stores = stores.filter((s) => fold(`${s.name} ${s.address} ${s.city}`).includes(fold(q)));
  }
  res.render('stores', { title: 'Hệ thống cửa hàng', stores, storeQuery: q });
});

// Liên hệ
app.get('/lien-he', (req, res) => {
  const values = { name: '', email: '', message: '' };
  if (typeof req.query.sp === 'string') {
    const product = db.prepare('SELECT name FROM products WHERE slug = ?').get(req.query.sp);
    if (product) values.message = `Tôi quan tâm đến sản phẩm: ${product.name}.`;
  }
  res.render('contact', { title: 'Liên hệ', values, errors: {}, sent: req.query.sent === '1' });
});

app.post('/lien-he', (req, res) => {
  const values = {
    name: formText(req.body.name),
    email: formText(req.body.email),
    message: formText(req.body.message),
  };

  const errors = {};
  if (!values.name || values.name.length > 100) errors.name = 'Vui lòng nhập họ tên.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) || values.email.length > 200) {
    errors.email = 'Email chưa đúng định dạng.';
  }
  if (!values.message) errors.message = 'Vui lòng nhập nội dung.';
  else if (values.message.length > 2000) errors.message = 'Nội dung tối đa 2000 ký tự.';

  if (Object.keys(errors).length) {
    return res.status(400).render('contact', { title: 'Liên hệ', values, errors, sent: false });
  }

  db.prepare('INSERT INTO messages (name, email, message) VALUES (?, ?, ?)')
    .run(values.name, values.email, values.message);
  res.redirect('/lien-he?sent=1');
});

// Giỏ hàng
app.get('/gio-hang', (req, res) => renderCart(req, res));

app.post('/gio-hang/them', (req, res) => {
  // nút "Thêm vào giỏ" gửi ngầm thì trả JSON để trang không phải chuyển đi
  const wantsJson = (req.get('accept') || '').includes('application/json');
  const fail = (path, message) => (wantsJson ? res.status(400).json({ error: message }) : res.redirect(path));
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(parseInt(req.body.product_id, 10) || 0);
  if (!product) return fail('/san-pham', 'Không tìm thấy sản phẩm.');

  const sizes = sizesOf(product);
  const size = sizes.length ? parseInt(req.body.size, 10) : 0;
  if (sizes.length && !sizes.includes(size)) {
    return fail(`/san-pham/${product.slug}?loi=size`, 'Vui lòng chọn size.');
  }
  // Không gửi màu (hoặc màu lạ) thì lấy màu mặc định của sản phẩm
  const colors = colorsOf(product.id);
  const picked = colors.find((c) => c.id === parseInt(req.body.color, 10)) || colors[0];
  const qty = Math.min(Math.max(parseInt(req.body.qty, 10) || 1, 1), MAX_QTY);

  const item = { id: product.id, color: picked ? picked.id : 0, size, qty };
  const items = readCart(req);
  const existing = items.find((i) => cartKey(i) === cartKey(item));

  // Không cho bỏ vào giỏ nhiều hơn số còn trong kho
  const left = stockOf(product.id, item.color, size);
  const wanted = Math.min((existing ? existing.qty : 0) + qty, MAX_QTY, left);
  if (wanted < 1) return fail(`/san-pham/${product.slug}?loi=het`, 'Lựa chọn này đã hết hàng.');

  if (existing) existing.qty = wanted;
  else if (items.length < MAX_LINES) items.push({ ...item, qty: wanted });
  writeCart(res, items);
  if (wantsJson) return res.json({ ok: true, count: items.reduce((sum, i) => sum + i.qty, 0) });
  res.redirect('/gio-hang');
});

app.post('/gio-hang/cap-nhat', (req, res) => {
  const qty = parseInt(req.body.qty, 10) || 0;
  const items = readCart(req);
  const index = items.findIndex((i) => cartKey(i) === req.body.key);
  if (index !== -1) {
    if (req.body.remove || qty < 1) items.splice(index, 1);
    else items[index].qty = Math.min(qty, MAX_QTY);
    writeCart(res, items);
  }
  res.redirect('/gio-hang');
});

app.post('/gio-hang/dat-hang', (req, res) => {
  const lines = cartLines(readCart(req));
  if (!lines.length) return res.redirect('/gio-hang');

  const values = {
    name: formText(req.body.name),
    phone: formText(req.body.phone),
    address: formText(req.body.address),
    note: formText(req.body.note).slice(0, 500),
    payment: req.body.payment === 'vnpay' && vnpay.enabled ? 'vnpay' : 'cod',
  };
  const errors = {};
  if (!values.name || values.name.length > 100) errors.name = 'Vui lòng nhập họ tên.';
  if (!/^[0-9+][0-9\s.-]{7,14}$/.test(values.phone)) errors.phone = 'Số điện thoại chưa đúng.';
  if (!values.address || values.address.length > 300) errors.address = 'Vui lòng nhập địa chỉ nhận hàng.';
  if (Object.keys(errors).length) return renderCart(req, res, { values, errors, status: 400 });

  let order;
  try {
    order = createOrder(lines, values, values.payment);
  } catch (err) {
    if (!(err instanceof OutOfStockError)) throw err;
    const stock = err.left
      ? `“${err.line.product.name}” chỉ còn ${err.left} sản phẩm. Vui lòng giảm số lượng.`
      : `“${err.line.product.name}” vừa hết hàng. Vui lòng xoá khỏi giỏ.`;
    return renderCart(req, res, { values, errors: { stock }, status: 409 });
  }

  const code = orderCode(order.id);
  if (values.payment === 'vnpay') {
    // Giỏ hàng được giữ lại cho tới khi thanh toán xong, để khách thử lại được nếu thẻ lỗi
    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    return res.redirect(vnpay.paymentUrl({
      orderId: order.id,
      amount: order.total,
      info: `Thanh toan don hang ${code}`,
      ip: req.ip,
      returnUrl: `${base}/thanh-toan/vnpay/ket-qua`,
    }));
  }

  writeCart(res, []);
  res.redirect(`/gio-hang/cam-on?ma=${code}`);
});

app.get('/gio-hang/cam-on', (req, res) => {
  const order = db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(orderIdFromCode(req.query.ma));
  if (!order) return res.redirect('/gio-hang');
  res.render('thanks', { title: 'Đã nhận đơn hàng', code: req.query.ma, paid: order.payment_status === 'paid' });
});

// VNPay đưa khách quay về đây sau khi thanh toán
app.get('/thanh-toan/vnpay/ket-qua', (req, res) => {
  const { order } = settleVnpay(req.query);
  if (order && order.payment_status === 'paid') {
    writeCart(res, []);
    return res.redirect(`/gio-hang/cam-on?ma=${orderCode(order.id)}`);
  }
  res.status(400).render('payment-failed', { title: 'Thanh toán chưa thành công' });
});

// VNPay gọi thẳng từ máy chủ của họ để báo kết quả (IPN), phòng khi khách đóng trình duyệt giữa chừng
app.get('/thanh-toan/vnpay/ipn', (req, res) => {
  const { code, message } = settleVnpay(req.query);
  res.json({ RspCode: code, Message: message });
});

// Các trang hỗ trợ: bảo hành, đổi trả, bảo mật, câu hỏi thường gặp
app.get('/ho-tro/:slug', (req, res, next) => {
  if (!Object.hasOwn(supportPages, req.params.slug)) return next();
  const page = supportPages[req.params.slug];
  res.render('page', { title: page.title, page, slug: req.params.slug });
});

app.use((req, res) => {
  res.status(404).render('404', { title: 'Không tìm thấy trang' });
});

syncAllMedia();

app.listen(PORT, () => {
  console.log(`${SITE.name} đang chạy tại http://localhost:${PORT}`);
  console.log(admin.enabled
    ? `Trang quản trị: http://localhost:${PORT}/admin`
    : 'Trang quản trị đang tắt: chưa đặt ADMIN_PASSWORD trong file .env');
});
