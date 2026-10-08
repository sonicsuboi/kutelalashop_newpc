const { Pool, types } = require('pg');
const { retailPrice } = require('./pricing');

// Toàn bộ code hiện coi created_at/paid_at là chuỗi UTC thô (thói quen từ SQLite TEXT).
// Tắt auto-parse của pg để timestamp/date trả về đúng dạng chuỗi "YYYY-MM-DD HH:MI:SS",
// tránh bị đổi thành Date object rồi lệch theo timezone của máy chạy Node.
types.setTypeParser(1114, (v) => v); // timestamp
types.setTypeParser(1082, (v) => v); // date
// Cột id là BIGINT, pg mặc định trả về chuỗi. Code so sánh id với số (màu khách chọn,
// màu trong giỏ hàng) nên đổi về số như SQLite trước đây.
types.setTypeParser(20, Number); // bigint

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Cho phép viết SQL với "?" như SQLite trước đây; chuyển thành "$1, $2, ..."
// của Postgres, bỏ qua "?" nằm trong chuỗi literal.
function toPgSql(sql) {
  let i = 0;
  let inStr = false;
  let out = '';
  for (const ch of sql) {
    if (ch === "'") inStr = !inStr;
    out += ch === '?' && !inStr ? '$' + (++i) : ch;
  }
  return out;
}

function makeRunner(exec) {
  return {
    async query(sql, params = []) {
      return (await exec(toPgSql(sql), params)).rows;
    },
    async one(sql, params = []) {
      const rows = await this.query(sql, params);
      return rows[0] || null;
    },
    async run(sql, params = []) {
      const r = await exec(toPgSql(sql), params);
      return { rowCount: r.rowCount };
    },
  };
}

const db = makeRunner((sql, params) => pool.query(sql, params));

// Chạy callback trong một transaction: mọi query bên trong dùng cùng một
// connection, nên BEGIN/COMMIT/ROLLBACK và các SELECT đọc được dữ liệu chưa
// commit của chính transaction đó.
async function withTransaction(callback) {
  const client = await pool.connect();
  const tx = makeRunner((sql, params) => client.query(sql, params));
  try {
    await client.query('BEGIN');
    const result = await callback(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function isEmpty(table) {
  return Number((await db.one(`SELECT COUNT(*) AS n FROM ${table}`)).n) === 0;
}

async function migrate() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      slug        TEXT NOT NULL UNIQUE,
      code        TEXT,
      name        TEXT NOT NULL,
      category    TEXT NOT NULL,
      badge       TEXT,
      cost        INTEGER,
      price       INTEGER NOT NULL,
      size_min    INTEGER NOT NULL DEFAULT 35,
      size_max    INTEGER NOT NULL DEFAULT 39,
      color       TEXT NOT NULL DEFAULT '#111111',
      sole_color  TEXT NOT NULL DEFAULT '#555555',
      image_url   TEXT,
      description TEXT,
      created_at  TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    );

    CREATE TABLE IF NOT EXISTS product_colors (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(id),
      name       TEXT NOT NULL,
      hex        TEXT NOT NULL,
      sole_hex   TEXT NOT NULL,
      sort       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS product_images (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(id),
      url        TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'image',
      color_id   BIGINT,
      sort       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS product_links (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(id),
      linked_id  BIGINT NOT NULL REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS stores (
      id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name    TEXT NOT NULL,
      address TEXT NOT NULL,
      city    TEXT NOT NULL,
      phone   TEXT,
      hours   TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name           TEXT NOT NULL,
      phone          TEXT NOT NULL,
      address        TEXT NOT NULL,
      note           TEXT,
      total          INTEGER NOT NULL,
      created_at     TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
      status         TEXT NOT NULL DEFAULT 'new',
      payment_method TEXT NOT NULL DEFAULT 'cod',
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      payment_ref    TEXT,
      paid_at        TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_id   BIGINT NOT NULL REFERENCES orders(id),
      product_id BIGINT NOT NULL,
      name       TEXT NOT NULL,
      color      TEXT,
      color_id   BIGINT NOT NULL DEFAULT 0,
      size       INTEGER NOT NULL,
      qty        INTEGER NOT NULL,
      price      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    );

    CREATE TABLE IF NOT EXISTS stock (
      product_id BIGINT NOT NULL REFERENCES products(id),
      color_id   BIGINT NOT NULL DEFAULT 0,
      size       INTEGER NOT NULL DEFAULT 0,
      qty        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (product_id, color_id, size)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      phone         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      address       TEXT,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    );

    -- Đơn của khách đã đăng nhập, và kênh đưa khách tới web lúc đặt (zalo, facebook, ...)
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id BIGINT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT;

    -- Mỗi lượt mở một trang. visitor là mã ngẫu nhiên lưu trong cookie của trình duyệt.
    CREATE TABLE IF NOT EXISTS visits (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      visitor    TEXT NOT NULL,
      path       TEXT NOT NULL,
      product_id BIGINT,
      source     TEXT NOT NULL,
      referrer   TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
    );
    CREATE INDEX IF NOT EXISTS visits_created ON visits(created_at);
    CREATE INDEX IF NOT EXISTS visits_product ON visits(product_id);

    CREATE TABLE IF NOT EXISTS favorites (
      visitor    TEXT NOT NULL,
      product_id BIGINT NOT NULL REFERENCES products(id),
      created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
      PRIMARY KEY (visitor, product_id)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      product_id  BIGINT NOT NULL REFERENCES products(id),
      customer_id BIGINT NOT NULL REFERENCES customers(id),
      rating      INTEGER NOT NULL,
      comment     TEXT NOT NULL,
      created_at  TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
      UNIQUE (product_id, customer_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS products_code ON products(code) WHERE code IS NOT NULL;
  `);

  // Sản phẩm mẫu, chỉ thêm khi bảng còn trống
  if (await isEmpty('products')) {
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
    for (const row of seed) {
      await db.run(`
        INSERT INTO products (slug, name, category, badge, price, size_max, color, sole_color, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, row);
    }
  }

  // Màu mẫu cho từng sản phẩm: [tên, màu thân, màu đế]. Màu đầu tiên là màu mặc định.
  if (await isEmpty('product_colors')) {
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
    for (const [slug, colors] of Object.entries(seed)) {
      const product = await db.one('SELECT id FROM products WHERE slug = ?', [slug]);
      if (!product) continue;
      for (let i = 0; i < colors.length; i++) {
        const [name, hex, sole] = colors[i];
        await db.run('INSERT INTO product_colors (product_id, name, hex, sole_hex, sort) VALUES (?, ?, ?, ?, ?)',
          [product.id, name, hex, sole, i]);
      }
    }
  }

  // Sản phẩm thật đầu tiên. Ảnh nằm trong bucket Storage ở prefix bup-be/KLBB001/.
  if (!(await db.one('SELECT 1 FROM products WHERE code = ?', ['KLBB001']))) {
    const cost = 390000;
    const { id } = await db.one(`
      INSERT INTO products (slug, code, name, category, badge, cost, price, size_min, size_max, color, sole_color, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [
      'giay-bet-quai-chun-cheo-klbb001', 'KLBB001','Giày bệt quai chun chéo da mềm', 'bup-be', 'Mới',
      cost, retailPrice('bup-be', cost), 35, 39, '#4a2c20', '#1e1410',
      'Giày bệt mũi vuông, quai chun đan chéo ôm chân, có miếng dán điều chỉnh. Da mềm, đế bệt, lót êm. Form chuẩn, fullbox.',
    ]);
    await db.run('INSERT INTO product_colors (product_id, name, hex, sole_hex, sort) VALUES (?, ?, ?, ?, ?)', [id, 'Nâu', '#4a2c20', '#1e1410', 0]);
    await db.run('INSERT INTO product_colors (product_id, name, hex, sole_hex, sort) VALUES (?, ?, ?, ?, ?)', [id, 'Đen', '#111111', '#111111', 1]);
  }

  // Sản phẩm có giá sỉ thì giá bán luôn tính lại theo pricing.js
  for (const p of await db.query('SELECT id, category, cost FROM products WHERE cost IS NOT NULL')) {
    await db.run('UPDATE products SET price = ? WHERE id = ?', [retailPrice(p.category, p.cost), p.id]);
  }

  // Tồn kho ban đầu: database chưa có dòng tồn kho nào thì đặt TẠM mỗi màu/size 5 sản phẩm
  // để shop bán được ngay. Số thật nhập ở trang quản trị (/admin/san-pham).
  if (await isEmpty('stock')) {
    for (const p of await db.query('SELECT id, size_min, size_max FROM products')) {
      const colorIds = (await db.query('SELECT id FROM product_colors WHERE product_id = ?', [p.id])).map((c) => c.id);
      for (const colorId of colorIds.length ? colorIds : [0]) {
        if (!p.size_max) {
          await db.run('INSERT INTO stock (product_id, color_id, size, qty) VALUES (?, ?, ?, 5)', [p.id, colorId, 0]);
        } else {
          for (let size = p.size_min; size <= p.size_max; size++) {
            await db.run('INSERT INTO stock (product_id, color_id, size, qty) VALUES (?, ?, ?, 5)', [p.id, colorId, size]);
          }
        }
      }
    }
  }

  if (await isEmpty('stores')) {
    const seed = [
      ['KUTELALA Sài Gòn', '123 Đường Mẫu, Quận 1', 'TP. Hồ Chí Minh', '0900 000 001', '9:00 – 21:00 hằng ngày'],
      ['KUTELALA Hà Nội', '45 Phố Mẫu, Quận Hoàn Kiếm', 'Hà Nội', '0900 000 002', '9:00 – 21:00 hằng ngày'],
      ['KUTELALA Đà Nẵng', '67 Đường Mẫu, Quận Hải Châu', 'Đà Nẵng', '0900 000 003', '9:00 – 21:00 hằng ngày'],
    ];
    for (const row of seed) {
      await db.run('INSERT INTO stores (name, address, city, phone, hours) VALUES (?, ?, ?, ?, ?)', row);
    }
  }
}

module.exports = { ...db, withTransaction, migrate, pool };
