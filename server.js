const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
// config phải nạp trước: nó đọc file .env mà vnpay.js và admin.js cần
const { SITE } = require('./config');
const { getSite } = require('./site');
const db = require('./db');
const supportPages = require('./content');
const { fold } = require('./text');
const { syncAllMedia, syncProductMedia } = require('./media');
const { CATEGORIES, GROUPS, groupOf, sizesOf, sizeLabel, colorsOf, stockOf, stockMap } = require('./catalog');
const {
  ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, shippingFee, orderCode, orderIdFromCode, OutOfStockError, createOrder, cancelOrder, markPaid,
} = require('./orders');
const vnpay = require('./vnpay');
const { bankOf, transferQr } = require('./vietqr');
const mail = require('./mail');
const admin = require('./admin');
const customers = require('./customers');
const { track } = require('./tracking');
const ah = require('./async-handler');

const app = express();
const PORT = process.env.PORT || 3000;
// Khi chạy sau proxy của nhà cung cấp hosting: lấy đúng địa chỉ khách và giao thức https
app.set('trust proxy', 1);

const SORTS = {
  newest: { label: 'Mới nhất', sql: 'created_at DESC, p.id ASC' },
  price_asc: { label: 'Giá tăng dần', sql: 'price ASC' },
  price_desc: { label: 'Giá giảm dần', sql: 'price DESC' },
};

// Sản phẩm đang ẩn (hidden) không xuất hiện ở bất kỳ trang bán hàng nào.
// Mọi truy vấn sản phẩm đều kèm số màu (đếm từ product_colors) và tổng số lượng còn trong kho
const PRODUCTS = `
  SELECT p.*,
    (SELECT COUNT(*) FROM product_colors c WHERE c.product_id = p.id)::int AS color_count,
    (SELECT COALESCE(SUM(qty), 0) FROM stock s WHERE s.product_id = p.id)::int AS stock_total
  FROM (SELECT * FROM products WHERE NOT hidden) p`;

// Ảnh nền trang chủ: bỏ ảnh tên hero.jpg (banner), story.jpg (khối "Về shop") hoặc
// store.jpg (ô "Thử giày tại cửa hàng") vào public/images là tự dùng; cũng nhận
// .jpeg / .png / .webp. Không có thì trả về fallback.
function findImage(name, fallback = null) {
  const ext = ['jpg', 'jpeg', 'png', 'webp'].find((e) =>
    fs.existsSync(path.join(__dirname, 'public', 'images', `${name}.${e}`)));
  return ext ? `/images/${name}.${ext}` : fallback;
}

// Địa chỉ gốc của web, dùng cho link tuyệt đối (canonical, sitemap, quay về sau thanh toán)
const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
// Cắt gọn một đoạn chữ cho thẻ mô tả, không cắt giữa từ
const excerpt = (s, max = 160) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, '') + '…');

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
async function cartLines(items) {
  const lines = [];
  for (const item of items) {
    const product = await db.one(`${PRODUCTS} WHERE p.id = ?`, [item.id]);
    if (!product) continue;
    const sizes = sizesOf(product);
    if (sizes.length ? !sizes.includes(item.size) : item.size !== 0) continue;
    const colors = await colorsOf(db, product.id);
    const color = colors.find((c) => c.id === item.color) || null;
    if (product.color_count && !color) continue;
    const colorId = color ? color.id : 0;
    lines.push({
      key: cartKey(item),
      // hình vẽ trong giỏ hiện đúng màu khách chọn
      product: color ? { ...product, color: color.hex, sole_color: color.sole_hex } : product,
      colorId,
      colorName: color ? color.name : '',
      size: item.size,
      sizeLabel: item.size ? sizeLabel(product, item.size) : '',
      qty: item.qty,
      left: await stockOf(db, product.id, colorId, item.size),
      subtotal: product.price * item.qty,
    });
  }
  return lines;
}

async function renderCart(req, res, { values = {}, errors = {}, status = 200 } = {}) {
  const lines = await cartLines(readCart(req));
  const { customer, site } = res.locals;
  const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
  const shipping = shippingFee(site, subtotal);
  res.status(status).render('cart', {
    title: 'Giỏ hàng',
    lines,
    subtotal,
    shipping,
    total: subtotal + shipping,
    // khách đã đăng nhập thì điền sẵn thông tin đã lưu
    values: {
      name: customer ? customer.name : '', phone: customer ? customer.phone : '',
      address: (customer && customer.address) || '', note: '', payment: 'cod', ...values,
    },
    errors,
    maxQty: MAX_QTY,
    cardPayment: vnpay.enabled,
    bankPayment: Boolean(bankOf(res.locals.site)),
  });
}

// Ghi nhận kết quả VNPay gửi về. Dùng chung cho trang khách quay về và lời gọi IPN,
// nên gọi nhiều lần cho cùng một đơn vẫn cho cùng kết quả.
async function settleVnpay(query) {
  const result = vnpay.verify(query);
  if (!result.valid) return { code: '97', message: 'Invalid signature' };
  const order = await db.one('SELECT * FROM orders WHERE id = ?', [result.orderId]);
  if (!order || order.payment_method !== 'vnpay') return { code: '01', message: 'Order not found' };
  if (order.total !== result.amount) return { code: '04', message: 'Invalid amount' };
  if (order.payment_status !== 'unpaid') return { code: '02', message: 'Order already confirmed', order };
  // Khách đã trả tiền thì luôn ghi nhận, kể cả khi đơn đã bị huỷ, để còn biết mà hoàn tiền
  if (result.success) await markPaid(order.id, result.ref);
  else await cancelOrder(order.id, 'failed');
  return {
    code: '00',
    message: 'Confirm Success',
    order: await db.one('SELECT * FROM orders WHERE id = ?', [order.id]),
  };
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

app.use(ah(async (req, res, next) => {
  res.locals.site = await getSite();
  res.locals.shopName = res.locals.site.name;
  // Chỉ hiện những danh mục đang có sản phẩm
  const counts = {};
  for (const row of await db.query('SELECT category, COUNT(*)::int AS n FROM products WHERE NOT hidden GROUP BY category')) {
    counts[row.category] = row.n;
  }
  res.locals.categoryCounts = counts;
  res.locals.categories = Object.fromEntries(
    Object.entries(CATEGORIES).filter(([key]) => counts[key]));
  // Nhóm hàng đang có sản phẩm, kèm các danh mục con. Nhóm chỉ có một danh mục thì link thẳng tới danh mục đó.
  res.locals.groups = Object.entries(GROUPS).map(([key, group]) => {
    const cats = group.categories.filter((c) => counts[c]).map((c) => ({ key: c, label: CATEGORIES[c], count: counts[c] }));
    return {
      key,
      label: group.label,
      categories: cats,
      count: cats.reduce((n, c) => n + c.count, 0),
      href: cats.length === 1 ? `/san-pham?loai=${cats[0].key}` : `/san-pham?nhom=${key}`,
    };
  }).filter((group) => group.count);
  res.locals.supportPages = supportPages;
  res.locals.current = { q: '' };
  res.locals.cartCount = readCart(req).reduce((sum, item) => sum + item.qty, 0);
  res.locals.formatPrice = (vnd) =>
    String(vnd).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' đ';
  res.locals.sizeLabel = sizeLabel;
  res.locals.customer = await customers.currentCustomer(req);
  // Thẻ SEO ở đầu trang (views/partials/header.ejs). Từng route ghi đè phần cần khác đi.
  const base = baseUrl(req);
  res.locals.seo = {
    base,
    title: '',
    description: res.locals.site.description,
    canonical: base + req.path,
    image: base + findImage('hero', '/images/hero.svg'),
    noindex: false,
    jsonLd: null,
  };
  next();
}));

// Các trang riêng của từng khách: không cho Google đưa vào kết quả tìm kiếm
const PRIVATE_PATHS = ['/gio-hang', '/tai-khoan', '/yeu-thich', '/tra-cuu-don', '/thanh-toan'];
app.use(PRIVATE_PATHS, (req, res, next) => {
  res.locals.seo.noindex = true;
  next();
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Disallow: /admin',
    ...PRIVATE_PATHS.map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${baseUrl(req)}/sitemap.xml`,
    '',
  ].join('\n'));
});

// Xác minh Google Search Console bằng cách "Tệp HTML": Google đòi web trả về đúng file google<mã>.html.
// Tên file khai báo ở trang quản trị (/admin/thong-tin), không cần tải file lên.
app.get(/^\/(google[0-9a-f]+\.html)$/, (req, res, next) => {
  if (res.locals.site.google_verify !== req.params[0]) return next();
  res.type('text/html').send(`google-site-verification: ${req.params[0]}`);
});

// Danh sách mọi trang công khai để Google tìm thấy hết sản phẩm
app.get('/sitemap.xml', ah(async (req, res) => {
  const base = baseUrl(req);
  const paths = [
    '/', '/san-pham',
    ...res.locals.groups.filter((g) => g.categories.length > 1).map((g) => g.href),
    ...Object.keys(res.locals.categories).map((key) => `/san-pham?loai=${key}`),
    ...(await db.query('SELECT slug FROM products WHERE NOT hidden ORDER BY id')).map((p) => `/san-pham/${p.slug}`),
    '/gioi-thieu', '/cua-hang', '/lien-he',
    ...Object.keys(supportPages).map((slug) => `/ho-tro/${slug}`),
  ];
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + paths.map((p) => `  <url><loc>${base}${p.replace(/&/g, '&amp;')}</loc></url>`).join('\n')
    + '\n</urlset>\n');
}));

// Trang quản trị: đơn hàng và kho sản phẩm
app.use('/admin', admin);

// Lượt truy cập và kênh đưa khách tới (không tính trang quản trị)
app.use(track);

// Tài khoản khách hàng
app.use('/tai-khoan', customers.router);

// Trang chủ
app.get('/', ah(async (req, res) => {
  const featured = await db.query(`${PRODUCTS} ORDER BY created_at DESC, p.id ASC LIMIT 5`);
  // Danh mục chưa có ảnh riêng thì lấy ảnh đại diện của sản phẩm mới nhất trong danh mục đó,
  // để dòng nào rê chuột vào cũng có ảnh nền chứ không chỉ nền đen
  const covers = Object.fromEntries((await db.query(`
    SELECT DISTINCT ON (category) category, image_url FROM products
    WHERE image_url IS NOT NULL AND NOT hidden ORDER BY category, created_at DESC, id DESC`)).map((r) => [r.category, r.image_url]));
  const { site, seo } = res.locals;
  seo.title = `${site.name} | Giày dép, túi xách, kính mát nữ`;
  seo.jsonLd = {
    '@context': 'https://schema.org', '@type': 'Store', name: site.name, url: seo.base + '/',
    description: site.description, telephone: site.phone, email: site.email, image: seo.image,
  };
  res.render('home', {
    title: 'Trang chủ',
    featured,
    counts: res.locals.categoryCounts,
    heroImage: findImage('hero', '/images/hero.svg'),
    storyImage: findImage('story'),
    storeImage: findImage('store'),
    // Ảnh nền hiện khi rê chuột vào từng dòng danh mục: public/images/categories/<mã danh mục>.jpg
    categoryImages: Object.fromEntries(
      Object.keys(CATEGORIES).map((key) => [key, findImage(`categories/${key}`) || covers[key] || null])),
  });
}));

// Danh sách sản phẩm
app.get('/san-pham', ah(async (req, res) => {
  const category = Object.hasOwn(CATEGORIES, req.query.loai) ? req.query.loai : '';
  // Đã chọn danh mục thì nhóm là nhóm chứa danh mục đó; chưa chọn thì lấy nhóm trên link (?nhom=)
  const group = category ? groupOf(category) : (Object.hasOwn(GROUPS, req.query.nhom) ? req.query.nhom : '');
  const sort = Object.hasOwn(SORTS, req.query.sort) ? req.query.sort : 'newest';
  const q = queryText(req.query.q);

  let products = category
    ? await db.query(`${PRODUCTS} WHERE category = ? ORDER BY ${SORTS[sort].sql}`, [category])
    : await db.query(`${PRODUCTS} ORDER BY ${SORTS[sort].sql}`);
  if (!category && group) products = products.filter((p) => GROUPS[group].categories.includes(p.category));
  if (q) products = products.filter((p) => fold(p.name).includes(fold(q)));

  // Ghi lại từ khoá khách tìm để shop biết khách cần gì (xem ở trang quản trị SEO)
  if (q && !req.isBot) {
    db.run('INSERT INTO searches (query, results, visitor) VALUES (?, ?, ?)', [q.toLowerCase(), products.length, req.visitor])
      .catch((err) => console.error('Không ghi được từ khoá tìm kiếm:', err.message || err.code));
  }

  const { seo, shopName } = res.locals;
  if (q) seo.noindex = true; // trang kết quả tìm kiếm không đưa lên Google
  const audience = group === 'tre-em' ? '' : ' nữ';
  if (category) {
    seo.canonical = `${seo.base}/san-pham?loai=${category}`;
    seo.title = `${CATEGORIES[category]}${audience} | ${shopName}`;
    seo.description = `${CATEGORIES[category]}${audience} tại ${shopName}: ${products.length} mẫu đang bán.`;
  } else if (group) {
    seo.canonical = `${seo.base}/san-pham?nhom=${group}`;
    seo.title = `${GROUPS[group].label}${audience} | ${shopName}`;
    seo.description = `${GROUPS[group].label}${audience} tại ${shopName}: ${products.length} mẫu đang bán.`;
  } else {
    seo.title = `Sản phẩm mới | ${shopName}`;
  }

  // Tạo link giữ nguyên các bộ lọc đang chọn, chỉ đổi phần truyền vào
  const link = (change) => {
    const next = { category, group, sort, q, ...change };
    const qs = new URLSearchParams();
    if (next.category) qs.set('loai', next.category);
    else if (next.group) qs.set('nhom', next.group);
    if (next.sort && next.sort !== 'newest') qs.set('sort', next.sort);
    if (next.q) qs.set('q', next.q);
    const s = qs.toString();
    return s ? '/san-pham?' + s : '/san-pham';
  };

  res.render('products', {
    title: category ? CATEGORIES[category] : group ? GROUPS[group].label : 'Sản phẩm mới',
    products,
    sorts: SORTS,
    current: { category, group, sort, q },
    link,
  });
}));

// Lượt xem, lượt yêu thích và đánh giá của một sản phẩm, kèm quyền đánh giá của khách đang xem:
// chỉ khách đã đăng nhập và có đơn hoàn tất chứa sản phẩm này mới được viết đánh giá.
async function productFeedback(product, customer, visitor) {
  const count = async (sql, ...args) => (await db.one(sql, args)).n;
  const reviews = await db.query(`
    SELECT r.id, r.rating, r.comment, r.created_at, r.customer_id, c.name
    FROM reviews r JOIN customers c ON c.id = r.customer_id
    WHERE r.product_id = ? ORDER BY r.id DESC LIMIT 100`, [product.id]);
  const bought = customer ? await db.query(`
    SELECT DISTINCT o.status FROM orders o JOIN order_items i ON i.order_id = o.id
    WHERE o.customer_id = ? AND i.product_id = ? AND o.status != 'cancelled'`, [customer.id, product.id]) : [];
  return {
    viewCount: await count('SELECT COUNT(*)::int AS n FROM visits WHERE product_id = ?', product.id),
    favCount: await count('SELECT COUNT(*)::int AS n FROM favorites WHERE product_id = ?', product.id),
    isFav: Boolean(await db.one('SELECT 1 FROM favorites WHERE visitor = ? AND product_id = ?', [visitor, product.id])),
    reviews,
    rating: reviews.length ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : 0,
    myReview: customer ? reviews.find((r) => r.customer_id === customer.id) || null : null,
    canReview: bought.some((o) => o.status === 'done'),
    waitingOrder: bought.length > 0 && !bought.some((o) => o.status === 'done'),
  };
}

// Chi tiết sản phẩm
app.get('/san-pham/:slug', ah(async (req, res, next) => {
  const product = await db.one(`${PRODUCTS} WHERE slug = ?`, [req.params.slug]);
  if (!product) return next();
  const related = await db
    .query(`${PRODUCTS} WHERE p.id != ? ORDER BY (category = ?) DESC, p.id ASC LIMIT 4`, [product.id, product.category]);

  // Ảnh và video ở trang chi tiết: đồng bộ lại với bucket Storage rồi đọc từ database,
  // nên tải file mới lên bucket là hiện ngay
  await syncProductMedia(product);
  const media = await db
    // video luôn đứng đầu bộ hình, sau đó tới ảnh theo thứ tự tên file
    .query("SELECT url, kind, color_id FROM product_images WHERE product_id = ? ORDER BY (kind = 'video') DESC, sort, id", [product.id]);
  if (!media.length && product.image_url) media.push({ url: product.image_url, kind: 'image', color_id: null });

  // Gợi ý mua kèm: lấy các sản phẩm đã gắn trong product_links; giày dép chưa gắn gì thì gợi ý kính
  let pairs = await db
    .query(`${PRODUCTS} JOIN product_links l ON l.linked_id = p.id WHERE l.product_id = ? ORDER BY l.id`, [product.id]);
  if (!pairs.length && groupOf(product.category) === 'giay-dep') {
    pairs = await db.query(`${PRODUCTS} WHERE category = 'kinh' ORDER BY created_at DESC, p.id DESC LIMIT 4`);
  }

  const colors = await colorsOf(db, product.id);
  const stock = await stockMap(db, product, colors);
  res.locals.viewedProduct = product.id;
  const feedback = await productFeedback(product, res.locals.customer, req.visitor);
  const stockTotal = Object.values(stock).reduce((sum, qty) => sum + qty, 0);

  // Thẻ SEO và dữ liệu có cấu trúc: Google dùng để hiện giá, tình trạng hàng và số sao trong kết quả tìm kiếm
  const { seo, shopName } = res.locals;
  const images = media.filter((m) => m.kind === 'image').map((m) => m.url);
  seo.title = `${product.name}${product.code ? ` (${product.code})` : ''} | ${shopName}`;
  seo.description = excerpt(`${product.description || product.name} Giá ${res.locals.formatPrice(product.price)}.`);
  if (images.length) seo.image = images[0];
  seo.jsonLd = {
    '@context': 'https://schema.org', '@type': 'Product',
    name: product.name,
    description: product.description || product.name,
    ...(product.code ? { sku: product.code } : {}),
    ...(images.length ? { image: images.slice(0, 6) } : {}),
    category: CATEGORIES[product.category],
    offers: {
      '@type': 'Offer', url: seo.canonical, priceCurrency: 'VND', price: product.price,
      availability: `https://schema.org/${stockTotal ? 'InStock' : 'OutOfStock'}`,
      itemCondition: 'https://schema.org/NewCondition',
    },
    ...(feedback.reviews.length ? {
      aggregateRating: { '@type': 'AggregateRating', ratingValue: Number(feedback.rating.toFixed(1)), reviewCount: feedback.reviews.length },
    } : {}),
  };

  res.render('product', {
    title: product.name,
    product,
    ...feedback,
    reviewError: req.query.loi === 'danh-gia',
    related,
    media,
    pairs,
    colors,
    sizes: sizesOf(product),
    // số lượng còn theo từng 'màu.size'
    stock,
    stockTotal,
    needSize: req.query.loi === 'size',
    outOfStock: req.query.loi === 'het',
  });
}));

// Dữ liệu cho hộp chọn nhanh màu / size ở trang danh sách (nút "Thêm vào giỏ" trên thẻ sản phẩm)
app.get('/san-pham/:slug/nhanh', ah(async (req, res, next) => {
  const product = await db.one(`${PRODUCTS} WHERE slug = ?`, [req.params.slug]);
  if (!product) return next();
  const colors = await colorsOf(db, product.id);
  res.json({
    id: product.id,
    slug: product.slug,
    name: product.name,
    price: res.locals.formatPrice(product.price),
    image: product.image_url,
    colors: colors.map((c) => ({ id: c.id, name: c.name, hex: c.hex })),
    sizes: sizesOf(product),
    sizeLabels: sizesOf(product).map((s) => sizeLabel(product, s)),
    stock: await stockMap(db, product, colors),
  });
}));

// Khách viết hoặc sửa đánh giá của mình (mỗi khách một đánh giá cho mỗi sản phẩm)
app.post('/san-pham/:slug/danh-gia', ah(async (req, res, next) => {
  const product = await db.one('SELECT id, slug FROM products WHERE slug = ?', [req.params.slug]);
  if (!product) return next();
  const { customer } = res.locals;
  if (!customer) return res.redirect(`/tai-khoan/dang-nhap?next=${encodeURIComponent(`/san-pham/${product.slug}#danh-gia`)}`);

  const rating = parseInt(req.body.rating, 10);
  const comment = formText(req.body.comment).slice(0, 1000);
  const { canReview } = await productFeedback(product, customer, req.visitor);
  if (!canReview || !(rating >= 1 && rating <= 5) || !comment) {
    return res.redirect(`/san-pham/${product.slug}?loi=danh-gia#danh-gia`);
  }
  await db.run(`
    INSERT INTO reviews (product_id, customer_id, rating, comment) VALUES (?, ?, ?, ?)
    ON CONFLICT (product_id, customer_id) DO UPDATE
      SET rating = excluded.rating, comment = excluded.comment, created_at = (now() AT TIME ZONE 'utc')
  `, [product.id, customer.id, rating, comment]);
  res.redirect(`/san-pham/${product.slug}#danh-gia`);
}));

// Yêu thích: danh sách lưu trên trình duyệt, trang này trả về mọi sản phẩm rồi JS lọc lại
app.get('/yeu-thich', ah(async (req, res) => {
  const products = await db.query(`${PRODUCTS} ORDER BY created_at DESC, p.id ASC`);
  res.render('favorites', { title: 'Yêu thích', products });
}));

// Trình duyệt báo về mỗi lần khách bấm / bỏ yêu thích, để đếm được số người thích từng sản phẩm.
// ids: danh sách id cách nhau dấu phẩy; on=0 là bỏ thích.
app.post('/yeu-thich', ah(async (req, res) => {
  const ids = String(req.body.ids || '').split(',').filter((id) => /^\d{1,9}$/.test(id)).slice(0, 100).map(Number);
  for (const id of ids) {
    if (req.body.on === '0') {
      await db.run('DELETE FROM favorites WHERE visitor = ? AND product_id = ?', [req.visitor, id]);
    } else if (await db.one('SELECT 1 FROM products WHERE id = ?', [id])) {
      await db.run('INSERT INTO favorites (visitor, product_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [req.visitor, id]);
    }
  }
  res.json({ ok: true });
}));

app.get('/gioi-thieu', (req, res) => {
  res.render('about', { title: 'Giới thiệu' });
});

// Hệ thống cửa hàng
app.get('/cua-hang', ah(async (req, res) => {
  const q = queryText(req.query.q);
  let stores = await db.query('SELECT * FROM stores ORDER BY id');
  if (q) {
    stores = stores.filter((s) => fold(`${s.name} ${s.address} ${s.city}`).includes(fold(q)));
  }
  res.render('stores', { title: 'Hệ thống cửa hàng', stores, storeQuery: q });
}));

// Liên hệ
app.get('/lien-he', ah(async (req, res) => {
  const { customer } = res.locals;
  const values = { name: customer ? customer.name : '', email: '', phone: customer ? customer.phone : '', message: '' };
  if (typeof req.query.sp === 'string') {
    const product = await db.one('SELECT name FROM products WHERE slug = ?', [req.query.sp]);
    if (product) values.message = `Tôi quan tâm đến sản phẩm: ${product.name}.`;
  }
  res.render('contact', { title: 'Liên hệ', values, errors: {}, sent: req.query.sent === '1' });
}));

app.post('/lien-he', ah(async (req, res) => {
  const values = {
    name: formText(req.body.name),
    email: formText(req.body.email),
    phone: formText(req.body.phone),
    message: formText(req.body.message),
  };

  // Khách để lại email hoặc số điện thoại, ít nhất một trong hai, để shop liên hệ lại
  const errors = {};
  if (!values.name || values.name.length > 100) errors.name = 'Vui lòng nhập họ tên.';
  if (values.email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) || values.email.length > 200)) {
    errors.email = 'Email chưa đúng định dạng.';
  }
  if (values.phone && !/^[0-9+][0-9\s.-]{7,14}$/.test(values.phone)) errors.phone = 'Số điện thoại chưa đúng.';
  if (!values.email && !values.phone) errors.phone = 'Vui lòng để lại số điện thoại hoặc email để shop liên hệ lại.';
  if (!values.message) errors.message = 'Vui lòng nhập nội dung.';
  else if (values.message.length > 2000) errors.message = 'Nội dung tối đa 2000 ký tự.';

  if (Object.keys(errors).length) {
    return res.status(400).render('contact', { title: 'Liên hệ', values, errors, sent: false });
  }

  await db.run('INSERT INTO messages (name, email, phone, message) VALUES (?, ?, ?, ?)',
    [values.name, values.email, values.phone || null, values.message]);
  mail.notify(res.locals.site, `Tin nhắn mới từ ${values.name}`, mail.messageEmail({ message: values, adminUrl: `/admin/tin-nhan` }));
  res.redirect('/lien-he?sent=1');
}));

// Giỏ hàng
app.get('/gio-hang', ah((req, res) => renderCart(req, res)));

app.post('/gio-hang/them', ah(async (req, res) => {
  // nút "Thêm vào giỏ" gửi ngầm thì trả JSON để trang không phải chuyển đi
  const wantsJson = (req.get('accept') || '').includes('application/json');
  const fail = (path, message) => (wantsJson ? res.status(400).json({ error: message }) : res.redirect(path));
  const product = await db.one('SELECT * FROM products WHERE id = ? AND NOT hidden', [parseInt(req.body.product_id, 10) || 0]);
  if (!product) return fail('/san-pham', 'Không tìm thấy sản phẩm.');

  const sizes = sizesOf(product);
  const size = sizes.length ? parseInt(req.body.size, 10) : 0;
  if (sizes.length && !sizes.includes(size)) {
    return fail(`/san-pham/${product.slug}?loi=size`, 'Vui lòng chọn size.');
  }
  // Không gửi màu (hoặc màu lạ) thì lấy màu mặc định của sản phẩm
  const colors = await colorsOf(db, product.id);
  const picked = colors.find((c) => c.id === parseInt(req.body.color, 10)) || colors[0];
  const qty = Math.min(Math.max(parseInt(req.body.qty, 10) || 1, 1), MAX_QTY);

  const item = { id: product.id, color: picked ? picked.id : 0, size, qty };
  const items = readCart(req);
  const existing = items.find((i) => cartKey(i) === cartKey(item));

  // Không cho bỏ vào giỏ nhiều hơn số còn trong kho
  const left = await stockOf(db, product.id, item.color, size);
  const wanted = Math.min((existing ? existing.qty : 0) + qty, MAX_QTY, left);
  if (wanted < 1) return fail(`/san-pham/${product.slug}?loi=het`, 'Lựa chọn này đã hết hàng.');

  if (existing) existing.qty = wanted;
  else if (items.length < MAX_LINES) items.push({ ...item, qty: wanted });
  writeCart(res, items);
  if (wantsJson) return res.json({ ok: true, count: items.reduce((sum, i) => sum + i.qty, 0) });
  res.redirect('/gio-hang');
}));

app.post('/gio-hang/cap-nhat', ah(async (req, res) => {
  const qty = parseInt(req.body.qty, 10) || 0;
  const items = readCart(req);
  const index = items.findIndex((i) => cartKey(i) === req.body.key);
  if (index !== -1) {
    if (req.body.remove || qty < 1) items.splice(index, 1);
    else items[index].qty = Math.min(qty, MAX_QTY);
    writeCart(res, items);
  }
  res.redirect('/gio-hang');
}));

app.post('/gio-hang/dat-hang', ah(async (req, res) => {
  const lines = await cartLines(readCart(req));
  if (!lines.length) return res.redirect('/gio-hang');

  const values = {
    name: formText(req.body.name),
    phone: formText(req.body.phone),
    address: formText(req.body.address),
    note: formText(req.body.note).slice(0, 500),
    payment: req.body.payment === 'vnpay' && vnpay.enabled ? 'vnpay'
      : req.body.payment === 'bank' && bankOf(res.locals.site) ? 'bank' : 'cod',
  };
  const errors = {};
  if (!values.name || values.name.length > 100) errors.name = 'Vui lòng nhập họ tên.';
  if (!/^[0-9+][0-9\s.-]{7,14}$/.test(values.phone)) errors.phone = 'Số điện thoại chưa đúng.';
  if (!values.address || values.address.length > 300) errors.address = 'Vui lòng nhập địa chỉ nhận hàng.';
  if (Object.keys(errors).length) return renderCart(req, res, { values, errors, status: 400 });

  const { customer } = res.locals;
  let order;
  try {
    const shipping = shippingFee(res.locals.site, lines.reduce((sum, line) => sum + line.subtotal, 0));
    order = await createOrder(lines, { ...values, customerId: customer && customer.id, source: req.source, shippingFee: shipping }, values.payment);
  } catch (err) {
    if (!(err instanceof OutOfStockError)) throw err;
    const stock = err.left
      ? `“${err.line.product.name}” chỉ còn ${err.left} sản phẩm. Vui lòng giảm số lượng.`
      : `“${err.line.product.name}” vừa hết hàng. Vui lòng xoá khỏi giỏ.`;
    return renderCart(req, res, { values, errors: { stock }, status: 409 });
  }

  // Báo cho shop qua email (không chờ gửi xong, lỗi gửi mail không ảnh hưởng tới đơn)
  mail.notify(res.locals.site, `Đơn mới ${orderCode(order.id)} – ${res.locals.formatPrice(order.total)}`, mail.orderEmail({
    order: {
      code: orderCode(order.id), name: values.name, phone: values.phone, address: values.address, note: values.note,
      total: order.total, shipping: order.total - lines.reduce((sum, line) => sum + line.subtotal, 0), payment: PAYMENT_METHOD[values.payment],
    },
    lines,
    formatPrice: res.locals.formatPrice,
    adminUrl: `${baseUrl(req)}/admin/don-hang/${order.id}`,
  }));

  // Tài khoản chưa lưu địa chỉ thì lấy luôn địa chỉ của đơn này cho lần sau
  if (customer && !customer.address) {
    await db.run('UPDATE customers SET address = ? WHERE id = ?', [values.address, customer.id]);
  }

  const code = orderCode(order.id);
  if (values.payment === 'vnpay') {
    // Giỏ hàng được giữ lại cho tới khi thanh toán xong, để khách thử lại được nếu thẻ lỗi
    const base = baseUrl(req);
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
}));

app.get('/gio-hang/cam-on', ah(async (req, res) => {
  const order = await db.one('SELECT id, total, payment_method, payment_status FROM orders WHERE id = ?', [orderIdFromCode(req.query.ma)]);
  if (!order) return res.redirect('/gio-hang');
  const paid = order.payment_status === 'paid';
  // Đơn chọn chuyển khoản mà chưa trả tiền: hiện mã QR, nội dung chuyển khoản là mã đơn
  const transfer = order.payment_method === 'bank' && !paid
    ? await transferQr(res.locals.site, order.total, orderCode(order.id)) : null;
  res.render('thanks', { title: 'Đã nhận đơn hàng', code: orderCode(order.id), paid, transfer, total: order.total });
}));

// Tra cứu đơn hàng cho khách không có tài khoản: cần đúng cả mã đơn và số điện thoại đã đặt
app.get('/tra-cuu-don', (req, res) => {
  res.render('order-lookup', { title: 'Tra cứu đơn hàng', values: { code: orderIdFromCode(req.query.ma) ? req.query.ma : '', phone: '' }, orders: [], searched: false, full: false });
});

// Tra theo số điện thoại đã đặt hàng. Chỉ nhập số điện thoại: liệt kê các đơn của số đó nhưng giấu địa chỉ
// giao hàng (ai biết số điện thoại cũng tra được). Nhập thêm đúng mã đơn: hiện đầy đủ một đơn đó.
app.post('/tra-cuu-don', ah(async (req, res) => {
  const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^84/, '0');
  const values = { code: formText(req.body.code).toUpperCase().replace(/\s/g, ''), phone: formText(req.body.phone) };
  const phone = digits(values.phone);
  let orders = phone.length < 9 ? [] : (await db.query('SELECT * FROM orders ORDER BY id DESC LIMIT 2000'))
    .filter((o) => digits(o.phone) === phone);
  const full = Boolean(values.code);
  if (full) orders = orders.filter((o) => o.id === orderIdFromCode(values.code));
  orders = orders.slice(0, 20);
  for (const order of orders) {
    order.items = await db.query(`
      SELECT i.name, i.color, i.size, i.size_label, i.qty, i.price, p.slug, p.image_url FROM order_items i
      LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = ? ORDER BY i.id`, [order.id]);
  }
  res.status(orders.length ? 200 : 404).render('order-lookup', {
    title: 'Tra cứu đơn hàng', values, orders, searched: true, full,
    statuses: ORDER_STATUS, payments: PAYMENT_STATUS, methods: PAYMENT_METHOD, orderCode,
  });
}));
// VNPay đưa khách quay về đây sau khi thanh toán
app.get('/thanh-toan/vnpay/ket-qua', ah(async (req, res) => {
  const { order } = await settleVnpay(req.query);
  if (order && order.payment_status === 'paid') {
    writeCart(res, []);
    return res.redirect(`/gio-hang/cam-on?ma=${orderCode(order.id)}`);
  }
  res.status(400).render('payment-failed', { title: 'Thanh toán chưa thành công' });
}));

// VNPay gọi thẳng từ máy chủ của họ để báo kết quả (IPN), phòng khi khách đóng trình duyệt giữa chừng
app.get('/thanh-toan/vnpay/ipn', ah(async (req, res) => {
  const { code, message } = await settleVnpay(req.query);
  res.json({ RspCode: code, Message: message });
}));

// Các trang hỗ trợ: bảo hành, đổi trả, bảo mật, câu hỏi thường gặp
app.get('/ho-tro/:slug', (req, res, next) => {
  if (!Object.hasOwn(supportPages, req.params.slug)) return next();
  const page = supportPages[req.params.slug];
  res.render('page', { title: page.title, page, slug: req.params.slug });
});

app.use((req, res) => {
  res.locals.seo.noindex = true;
  res.status(404).render('404', { title: 'Không tìm thấy trang' });
});

(async () => {
  try {
    await db.migrate();
    await syncAllMedia();
  } catch (err) {
    console.error('Không kết nối được database. Kiểm tra DATABASE_URL trong file .env.');
    // lỗi kết nối gộp (AggregateError) có message rỗng nên in cả mã lỗi và các lỗi con
    console.error(err.message || err.code || '', ...(err.errors || []).map((e) => e.message));
    if (!process.env.DATABASE_URL) console.error('Biến DATABASE_URL đang trống.');
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`${SITE.name} đang chạy tại http://localhost:${PORT}`);
    console.log(admin.enabled
      ? `Trang quản trị: http://localhost:${PORT}/admin`
      : 'Trang quản trị đang tắt: chưa đặt ADMIN_PASSWORD trong file .env');
  });
})();
