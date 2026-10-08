const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { retailPrice } = require('./pricing');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// DB_FILE cho phép chạy thử trên một bản sao của database
const db = new DatabaseSync(process.env.DB_FILE || path.join(dataDir, 'shop.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,
    code        TEXT,                   -- mã sản phẩm, cũng là tên thư mục ảnh/video: public/uploads/<danh mục>/<mã>/
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,          -- sneaker | cao-got | sandal | bup-be | boot | dep | kinh | tui
    badge       TEXT,                   -- vd: 'Độc quyền', 'Mới'
    cost        INTEGER,                -- giá sỉ (VND), không hiện ra web; có giá sỉ thì giá bán tự tính
    price       INTEGER NOT NULL,       -- giá bán (VND)
    size_min    INTEGER NOT NULL DEFAULT 35,      -- sản phẩm không có size (kính) thì để 0
    size_max    INTEGER NOT NULL DEFAULT 39,      -- tuỳ sản phẩm, có mẫu tới 40
    color       TEXT NOT NULL DEFAULT '#111111',  -- màu thân giày của hình vẽ ở trang danh sách
    sole_color  TEXT NOT NULL DEFAULT '#555555',  -- màu đế / gót của hình vẽ ở trang danh sách
    image_url   TEXT,                   -- ảnh đại diện; nếu trống thì dùng hình vẽ
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Các màu của từng sản phẩm, khách chọn ở trang chi tiết
  CREATE TABLE IF NOT EXISTS product_colors (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    name       TEXT NOT NULL,           -- vd: 'Đen', 'Kem', 'Nâu bò'
    hex        TEXT NOT NULL,           -- màu ô chọn, cũng là màu thân giày của hình vẽ
    sole_hex   TEXT NOT NULL,           -- màu đế / gót của hình vẽ
    sort       INTEGER NOT NULL DEFAULT 0
  );

  -- Ảnh và video của sản phẩm ở trang chi tiết. Chỉ lưu đường dẫn; file nằm trong
  -- public/uploads/<danh mục>/<mã sản phẩm>/ và được media.js tự ghi vào đây.
  CREATE TABLE IF NOT EXISTS product_images (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    url        TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'image',     -- image | video
    color_id   INTEGER,                           -- ảnh của riêng một màu (product_colors.id)
    sort       INTEGER NOT NULL DEFAULT 0
  );

  -- Sản phẩm gợi ý mua kèm, vd: từ một đôi giày sang chiếc kính chụp cùng
  CREATE TABLE IF NOT EXISTS product_links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    linked_id  INTEGER NOT NULL REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS stores (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL,
    address TEXT NOT NULL,
    city    TEXT NOT NULL,
    phone   TEXT,
    hours   TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    address    TEXT NOT NULL,
    note       TEXT,
    total      INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Tên, màu và giá được chép lại lúc đặt để đơn cũ không đổi khi sửa sản phẩm
  CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL,
    name       TEXT NOT NULL,
    color      TEXT,
    size       INTEGER NOT NULL,
    qty        INTEGER NOT NULL,
    price      INTEGER NOT NULL
  );

  -- Tin nhắn khách gửi từ trang Liên hệ
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Database tạo từ bản cũ: size lưu dạng chữ ('35 – 39') và số màu là một con số gõ tay.
// Chuyển sang size_min / size_max, còn số màu giờ đếm từ bảng product_colors.
const productColumns = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
if (!productColumns.includes('size_max')) {
  db.exec(`
    ALTER TABLE products ADD COLUMN size_min INTEGER NOT NULL DEFAULT 35;
    ALTER TABLE products ADD COLUMN size_max INTEGER NOT NULL DEFAULT 39;
  `);
  if (productColumns.includes('sizes')) {
    db.exec(`
      UPDATE products SET size_max = 40 WHERE sizes LIKE '%40%';
      ALTER TABLE products DROP COLUMN sizes;
    `);
  }
}
if (productColumns.includes('color_count')) {
  db.exec('ALTER TABLE products DROP COLUMN color_count');
}

// Cột thêm sau này: database cũ chưa có thì bổ sung
const addColumn = (table, column, definition) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};
addColumn('products', 'code', 'TEXT');
addColumn('products', 'cost', 'INTEGER');
addColumn('product_images', 'kind', "TEXT NOT NULL DEFAULT 'image'");
addColumn('product_images', 'color_id', 'INTEGER');
addColumn('orders', 'status', "TEXT NOT NULL DEFAULT 'new'");              // new | confirmed | shipping | done | cancelled
addColumn('orders', 'payment_method', "TEXT NOT NULL DEFAULT 'cod'");      // cod | vnpay
addColumn('orders', 'payment_status', "TEXT NOT NULL DEFAULT 'unpaid'");   // unpaid | paid | failed
addColumn('orders', 'payment_ref', 'TEXT');                                // mã giao dịch của cổng thanh toán
addColumn('orders', 'paid_at', 'TEXT');
addColumn('order_items', 'color_id', 'INTEGER NOT NULL DEFAULT 0');

// Tồn kho theo từng biến thể: màu (0 nếu sản phẩm không có màu) + size (0 nếu không có size)
db.exec(`
  CREATE TABLE IF NOT EXISTS stock (
    product_id INTEGER NOT NULL REFERENCES products(id),
    color_id   INTEGER NOT NULL DEFAULT 0,
    size       INTEGER NOT NULL DEFAULT 0,
    qty        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, color_id, size)
  );
`);
// Mã sản phẩm là tên thư mục ảnh nên không được trùng
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS products_code ON products(code) WHERE code IS NOT NULL');

const isEmpty = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n === 0;

// Dữ liệu mẫu, chỉ thêm khi bảng còn trống
if (isEmpty('products')) {
  const insert = db.prepare(`
    INSERT INTO products (slug, name, category, badge, price, size_max, color, sole_color, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const seed = [
    ['cao-got-mui-nhon-den', 'Giày cao gót mũi nhọn đen', 'cao-got', 'Độc quyền', 2490000, 39, '#111111', '#111111',
      'Mũi nhọn, gót mảnh. Dáng cổ điển tôn cổ chân, hợp cả công sở lẫn tiệc tối.'],
    ['sneaker-de-bang-trang-kem', 'Sneaker đế bằng trắng kem', 'sneaker', 'Mới', 1890000, 40, '#e8e0d0', '#111111',
      'Thân trắng kem, đế đen tương phản. Đi cả ngày vẫn êm.'],
    ['sandal-quai-manh-nau-bo', 'Sandal quai mảnh nâu bò', 'sandal', 'Mới', 1290000, 39, '#9a6a3a', '#3a2a1c',
      'Quai mảnh ôm chân, đế bệt nhẹ. Tối giản cho ngày hè.'],
    ['boot-co-ngan-den', 'Boot cổ ngắn đen', 'boot', 'Độc quyền', 3290000, 39, '#111111', '#333333',
      'Cổ ngắn ôm mắt cá, gót vuông vững chân. Mạnh mẽ mà vẫn thanh.'],
    ['bup-be-no-be', 'Giày búp bê nơ be', 'bup-be', null, 1490000, 39, '#d8c3a5', '#6b4a2e',
      'Mũi tròn, đính nơ nhỏ. Mềm, nhẹ, dễ phối đồ.'],
    ['dep-quai-ngang-kem', 'Dép quai ngang kem', 'dep', null, 890000, 39, '#e3d6bf', '#8a6f4d',
      'Quai ngang bản to, đế dày êm. Xỏ là đi.'],
    ['sneaker-de-chunky-den', 'Sneaker đế chunky đen', 'sneaker', null, 2290000, 40, '#111111', '#cfcfcf',
      'Thân đen, đế dày sáng màu. Thêm chiều cao, thêm cá tính.'],
    ['cao-got-mui-nhon-do-ruou', 'Giày cao gót mũi nhọn đỏ rượu', 'cao-got', 'Mới', 2690000, 39, '#7a1f2b', '#3d0f15',
      'Sắc đỏ rượu trầm, gót mảnh. Điểm nhấn cho bộ đồ tối màu.'],
    ['sandal-quai-manh-den', 'Sandal quai mảnh đen', 'sandal', null, 1190000, 39, '#111111', '#444444',
      'Quai mảnh màu đen, đế bệt. Gọn gàng, dễ mang.'],
    ['bup-be-den', 'Giày búp bê đen', 'bup-be', 'Mới', 1390000, 39, '#111111', '#555555',
      'Phom búp bê cổ điển màu đen. Đi làm, đi chơi đều hợp.'],
    ['boot-co-ngan-nau', 'Boot cổ ngắn nâu', 'boot', null, 3090000, 39, '#6b3f1d', '#2b1a0c',
      'Tông nâu ấm, cổ ngắn, gót vuông.'],
    ['dep-quai-ngang-den', 'Dép quai ngang đen', 'dep', 'Mới', 790000, 39, '#111111', '#555555',
      'Quai ngang màu đen, đế dày. Tối giản cho mọi ngày.'],
  ];
  for (const row of seed) insert.run(...row);
}

// Màu mẫu cho từng sản phẩm: [tên, màu thân, màu đế]. Màu đầu tiên là màu mặc định.
if (isEmpty('product_colors')) {
  const BLACK = ['Đen', '#111111', '#444444'];
  const CREAM = ['Kem', '#e3d6bf', '#8a6f4d'];
  const BROWN = ['Nâu', '#6b3f1d', '#2b1a0c'];
  const TAN = ['Nâu bò', '#9a6a3a', '#3a2a1c'];
  const WINE = ['Đỏ rượu', '#7a1f2b', '#3d0f15'];
  const BEIGE = ['Be', '#d8c3a5', '#6b4a2e'];
  const seed = {
    'cao-got-mui-nhon-den': [['Đen', '#111111', '#111111'], CREAM, WINE],
    'sneaker-de-bang-trang-kem': [['Trắng kem', '#e8e0d0', '#111111'], ['Đen', '#111111', '#e8e0d0'], ['Xám', '#9a9a9a', '#333333']],
    'sandal-quai-manh-nau-bo': [TAN, BLACK, CREAM],
    'boot-co-ngan-den': [['Đen', '#111111', '#333333'], BROWN],
    'bup-be-no-be': [BEIGE, BLACK, ['Hồng phấn', '#e3b7b0', '#8a5a52'], WINE],
    'dep-quai-ngang-kem': [CREAM, BLACK, TAN, ['Xanh rêu', '#5b6b4a', '#2f3826']],
    'sneaker-de-chunky-den': [['Đen', '#111111', '#cfcfcf'], ['Trắng kem', '#e8e0d0', '#9a9a9a']],
    'cao-got-mui-nhon-do-ruou': [WINE, ['Đen', '#111111', '#111111']],
    'sandal-quai-manh-den': [BLACK, TAN, CREAM],
    'bup-be-den': [['Đen', '#111111', '#555555'], BEIGE, WINE],
    'boot-co-ngan-nau': [BROWN, ['Đen', '#111111', '#333333']],
    'dep-quai-ngang-den': [['Đen', '#111111', '#555555'], CREAM, TAN],
  };
  const findProduct = db.prepare('SELECT id FROM products WHERE slug = ?');
  const insert = db.prepare('INSERT INTO product_colors (product_id, name, hex, sole_hex, sort) VALUES (?, ?, ?, ?, ?)');
  for (const [slug, colors] of Object.entries(seed)) {
    const product = findProduct.get(slug);
    if (!product) continue;
    colors.forEach(([name, hex, sole], i) => insert.run(product.id, name, hex, sole, i));
  }
}

// Sản phẩm thật đầu tiên. Ảnh nằm trong public/uploads/bup-be/KRM7633/.
if (!db.prepare('SELECT 1 FROM products WHERE code = ?').get('KRM7633')) {
  const cost = 390000;
  const { lastInsertRowid: id } = db.prepare(`
    INSERT INTO products (slug, code, name, category, badge, cost, price, size_min, size_max, color, sole_color, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'giay-bet-quai-chun-cheo-krm7633', 'KRM7633', 'Giày bệt quai chun chéo da mềm', 'bup-be', 'Mới',
    cost, retailPrice('bup-be', cost), 35, 39, '#4a2c20', '#1e1410',
    'Giày bệt mũi vuông, quai chun đan chéo ôm chân, có miếng dán điều chỉnh. Da mềm, đế bệt, lót êm. Form chuẩn, fullbox.');
  const insertColor = db.prepare('INSERT INTO product_colors (product_id, name, hex, sole_hex, sort) VALUES (?, ?, ?, ?, ?)');
  insertColor.run(id, 'Nâu', '#4a2c20', '#1e1410', 0);
  insertColor.run(id, 'Đen', '#111111', '#111111', 1);
}

// Sản phẩm có giá sỉ thì giá bán luôn tính lại theo pricing.js
const setPrice = db.prepare('UPDATE products SET price = ? WHERE id = ?');
for (const p of db.prepare('SELECT id, category, cost FROM products WHERE cost IS NOT NULL').all()) {
  setPrice.run(retailPrice(p.category, p.cost), p.id);
}

// Tồn kho ban đầu: database chưa có dòng tồn kho nào thì đặt TẠM mỗi màu/size 5 sản phẩm
// để shop bán được ngay. Số thật nhập ở trang quản trị (/admin/san-pham).
if (isEmpty('stock')) {
  const insert = db.prepare('INSERT INTO stock (product_id, color_id, size, qty) VALUES (?, ?, ?, 5)');
  const colorIdsOf = db.prepare('SELECT id FROM product_colors WHERE product_id = ?');
  for (const p of db.prepare('SELECT id, size_min, size_max FROM products').all()) {
    const colorIds = colorIdsOf.all(p.id).map((c) => c.id);
    for (const colorId of colorIds.length ? colorIds : [0]) {
      if (!p.size_max) insert.run(p.id, colorId, 0);
      else for (let size = p.size_min; size <= p.size_max; size++) insert.run(p.id, colorId, size);
    }
  }
}

if (isEmpty('stores')) {
  const insert = db.prepare('INSERT INTO stores (name, address, city, phone, hours) VALUES (?, ?, ?, ?, ?)');
  const seed = [
    ['KUTELALA Sài Gòn', '123 Đường Mẫu, Quận 1', 'TP. Hồ Chí Minh', '0900 000 001', '9:00 – 21:00 hằng ngày'],
    ['KUTELALA Hà Nội', '45 Phố Mẫu, Quận Hoàn Kiếm', 'Hà Nội', '0900 000 002', '9:00 – 21:00 hằng ngày'],
    ['KUTELALA Đà Nẵng', '67 Đường Mẫu, Quận Hải Châu', 'Đà Nẵng', '0900 000 003', '9:00 – 21:00 hằng ngày'],
  ];
  for (const row of seed) insert.run(...row);
}

module.exports = db;
