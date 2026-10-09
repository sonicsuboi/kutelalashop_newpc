// Danh mục, màu, size và tồn kho của sản phẩm: dùng chung cho trang bán hàng và trang quản trị
const CATEGORIES = {
  sneaker: 'Sneaker',
  'cao-got': 'Giày cao gót',
  sandal: 'Sandal',
  'bup-be': 'Giày búp bê',
  boot: 'Boot',
  dep: 'Dép',
  kinh: 'Kính mát',
  tui: 'Túi xách',
  'be-trai': 'Đồ bé trai',
  'be-gai': 'Đồ bé gái',
};

// Nhóm hàng: cấp trên của danh mục, dùng cho menu và bộ lọc. Thêm danh mục mới thì ghi vào đúng nhóm ở đây.
const GROUPS = {
  'giay-dep': { label: 'Giày dép', categories: ['sneaker', 'cao-got', 'sandal', 'bup-be', 'boot', 'dep'] },
  'tui-xach': { label: 'Túi xách', categories: ['tui'] },
  'phu-kien': { label: 'Kính & phụ kiện', categories: ['kinh'] },
  'tre-em': { label: 'Trẻ em', categories: ['be-trai', 'be-gai'] },
};
const groupOf = (category) => Object.keys(GROUPS).find((key) => GROUPS[key].categories.includes(category)) || '';

// Mã sản phẩm: KL + chữ danh mục + số thứ tự 3 chữ số, vd: KLCG001, KLSN012
const CODE_PREFIXES = {
  sneaker: 'KLSN',
  'cao-got': 'KLCG',
  sandal: 'KLSD',
  'bup-be': 'KLBB',
  boot: 'KLBT',
  dep: 'KLDP',
  kinh: 'KLKM',
  tui: 'KLTX',
  'be-trai': 'KLTT',
  'be-gai': 'KLTG',
};

// Mã kế tiếp của danh mục: số lớn nhất đang có cộng 1
async function nextCode(db, category) {
  const prefix = CODE_PREFIXES[category];
  const rows = await db.query('SELECT code FROM products WHERE code LIKE ?', [`${prefix}%`]);
  const used = rows.map((r) => r.code.slice(prefix.length)).filter((n) => /^\d+$/.test(n)).map(Number);
  return prefix + String(Math.max(0, ...used) + 1).padStart(3, '0');
}

// Quần áo dùng size chữ (M, L, XL...): tên các size nằm trong cột size_labels, cách nhau dấu phẩy,
// còn tồn kho, giỏ hàng và đơn hàng vẫn ghi size bằng số thứ tự 1, 2, 3... của tên đó.
const sizeLabelsOf = (product) => (product.size_labels ? product.size_labels.split(',') : null);
// Chữ hiện cho khách của một size: tên size chữ nếu có, không thì chính con số (size giày)
const sizeLabel = (product, size) => (sizeLabelsOf(product) || [])[size - 1] || String(size);

// Sản phẩm không có size (kính, túi) để size_max = 0 và trả về danh sách rỗng
const sizesOf = (product) => {
  const sizes = [];
  const labels = sizeLabelsOf(product);
  if (labels) return labels.map((label, i) => i + 1);
  if (!product.size_max) return sizes;
  for (let s = product.size_min; s <= product.size_max; s++) sizes.push(s);
  return sizes;
};

const colorsOf = (db, productId) =>
  db.query('SELECT * FROM product_colors WHERE product_id = ? ORDER BY sort, id', [productId]);

// Tồn kho tính theo từng biến thể (màu + size). Sản phẩm không có màu dùng màu 0, không có size dùng size 0.
async function variantsOf(db, product, colors) {
  if (!colors) colors = await colorsOf(db, product.id);
  const colorIds = colors.length ? colors.map((c) => c.id) : [0];
  const sizes = sizesOf(product);
  const variants = [];
  for (const colorId of colorIds) {
    for (const size of sizes.length ? sizes : [0]) variants.push({ colorId, size });
  }
  return variants;
}

// { 'màu.size': số lượng còn } của các biến thể đang có
async function stockMap(db, product, colors) {
  const rows = await db.query('SELECT color_id, size, qty FROM stock WHERE product_id = ?', [product.id]);
  const byKey = new Map(rows.map((r) => [`${r.color_id}.${r.size}`, r.qty]));
  const map = {};
  for (const v of await variantsOf(db, product, colors)) map[`${v.colorId}.${v.size}`] = byKey.get(`${v.colorId}.${v.size}`) || 0;
  return map;
}

async function stockOf(db, productId, colorId, size) {
  const row = await db.one('SELECT qty FROM stock WHERE product_id = ? AND color_id = ? AND size = ?', [productId, colorId, size]);
  return row ? row.qty : 0;
}

async function setStock(db, productId, colorId, size, qty) {
  await db.run(`
    INSERT INTO stock (product_id, color_id, size, qty) VALUES (?, ?, ?, ?)
    ON CONFLICT (product_id, color_id, size) DO UPDATE SET qty = excluded.qty
  `, [productId, colorId, size, qty]);
}

// delta âm khi bán, dương khi huỷ đơn trả hàng về kho
async function changeStock(db, productId, colorId, size, delta) {
  await db.run(`
    INSERT INTO stock (product_id, color_id, size, qty) VALUES (?, ?, ?, GREATEST(?, 0))
    ON CONFLICT (product_id, color_id, size) DO UPDATE SET qty = GREATEST(stock.qty + ?, 0)
  `, [productId, colorId, size, delta, delta]);
}

module.exports = { CATEGORIES, GROUPS, groupOf, CODE_PREFIXES, nextCode, sizesOf, sizeLabel, colorsOf, variantsOf, stockMap, stockOf, setStock, changeStock };
