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
};

// Sản phẩm không có size (kính, túi) để size_max = 0 và trả về danh sách rỗng
const sizesOf = (product) => {
  const sizes = [];
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

module.exports = { CATEGORIES, sizesOf, colorsOf, variantsOf, stockMap, stockOf, setStock, changeStock };
