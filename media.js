// Ảnh và video sản phẩm nằm trong thư mục theo danh mục rồi tới mã sản phẩm:
//
//   public/uploads/<danh mục>/<mã sản phẩm>/        vd: public/uploads/bup-be/KRM7633/
//
// Database (bảng product_images) chỉ lưu đường dẫn tới file, không lưu nội dung file.
// Các hàm dưới đây quét thư mục rồi ghi/xoá các dòng tương ứng, nên chỉ cần chép file vào là xong.
// Thư mục của mỗi sản phẩm có mã được tạo sẵn khi server khởi động.
//
// Quy ước tên file:
//   - Thứ tự hiển thị theo tên file (01.jpg, 02.jpg, ...). Ảnh đầu tiên là ảnh đại diện.
//   - File bắt đầu bằng tên màu không dấu viết liền (nau-1.jpg, den-2.jpg, naubo-1.jpg)
//     được gắn với màu đó: khách chọn màu thì nhảy tới ảnh của màu.
//   - Video: .mp4, .webm hoặc .mov (video quay bằng iPhone). Ở trang chi tiết video luôn hiện đầu tiên, trước các ảnh.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const { fold } = require('./text');

const UPLOADS = path.join(__dirname, 'public', 'uploads');
const KINDS = { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.mp4': 'video', '.webm': 'video', '.mov': 'video' };
const kindOf = (file) => KINDS[path.extname(file).toLowerCase()];

// Mã sản phẩm dùng làm tên thư mục nên chỉ nhận chữ, số, gạch ngang, gạch dưới
const validCode = (code) => typeof code === 'string' && /^[A-Za-z0-9_-]+$/.test(code);

const folderOf = (product) => path.join(UPLOADS, product.category, product.code);
const urlPrefixOf = (product) => `/uploads/${product.category}/${product.code}/`;

function listFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(kindOf).sort() : [];
}

function syncProductMedia(product, { createFolder = false } = {}) {
  if (!validCode(product.code)) return;
  const dir = folderOf(product);
  const prefix = urlPrefixOf(product);
  if (createFolder) fs.mkdirSync(dir, { recursive: true });

  const files = listFiles(dir);
  const rows = db.prepare('SELECT id, url FROM product_images WHERE product_id = ?').all(product.id);
  const known = new Set(rows.map((r) => r.url));
  const wanted = new Set(files.map((f) => prefix + f));

  // Dòng trỏ tới file trong uploads mà không còn trong thư mục của sản phẩm thì bỏ
  // (file đã xoá, hoặc thư mục đã chuyển chỗ). Link ngoài (http...) được giữ nguyên.
  for (const row of rows) {
    if (row.url.startsWith('/uploads/') && !wanted.has(row.url)) {
      db.prepare('DELETE FROM product_images WHERE id = ?').run(row.id);
    }
  }

  const colors = db.prepare('SELECT id, name FROM product_colors WHERE product_id = ?').all(product.id);
  const colorOf = (file) => {
    const start = file.toLowerCase().split(/[-_.]/)[0];
    const match = colors.find((c) => fold(c.name).replace(/\s+/g, '') === start);
    return match ? match.id : null;
  };

  const insert = db.prepare(
    'INSERT INTO product_images (product_id, url, kind, color_id, sort) VALUES (?, ?, ?, ?, ?)');
  // File đã có thì cập nhật lại thứ tự, để thêm file mới vào giữa vẫn xếp đúng theo tên
  const reorder = db.prepare('UPDATE product_images SET sort = ? WHERE product_id = ? AND url = ?');
  files.forEach((file, i) => {
    const url = prefix + file;
    if (known.has(url)) reorder.run(i, product.id, url);
    else insert.run(product.id, url, kindOf(file), colorOf(file), i);
  });

  // Ảnh đại diện: ảnh đầu tiên trong thư mục, nếu sản phẩm chưa có hoặc ảnh cũ không còn
  const cover = files.find((f) => kindOf(f) === 'image');
  const coverGone = product.image_url && product.image_url.startsWith('/uploads/') && !wanted.has(product.image_url);
  if (cover && (!product.image_url || coverGone)) {
    db.prepare('UPDATE products SET image_url = ? WHERE id = ?').run(prefix + cover, product.id);
    product.image_url = prefix + cover;
  }
}

function syncAllMedia() {
  for (const product of db.prepare('SELECT * FROM products WHERE code IS NOT NULL').all()) {
    syncProductMedia(product, { createFolder: true });
  }
}

// Bảng kiểm tra: sản phẩm nào chưa có mã / chưa có ảnh, thư mục nào không thuộc sản phẩm nào
function mediaReport() {
  const products = db.prepare('SELECT id, code, name, category FROM products ORDER BY category, code').all();
  const expected = new Set();
  const report = { byCategory: {}, noCode: [], badCode: [], noMedia: [], orphanFolders: [], totalFiles: 0, totalBytes: 0 };

  for (const product of products) {
    const stats = (report.byCategory[product.category] ||= { products: 0, withMedia: 0, files: 0 });
    stats.products++;
    if (!product.code) { report.noCode.push(product); continue; }
    if (!validCode(product.code)) { report.badCode.push(product); continue; }
    expected.add(`${product.category}/${product.code}`);
    const dir = folderOf(product);
    const files = listFiles(dir);
    if (!files.length) { report.noMedia.push(product); continue; }
    stats.withMedia++;
    stats.files += files.length;
    report.totalFiles += files.length;
    for (const file of files) report.totalBytes += fs.statSync(path.join(dir, file)).size;
  }

  if (fs.existsSync(UPLOADS)) {
    for (const category of fs.readdirSync(UPLOADS, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      const entries = fs.readdirSync(path.join(UPLOADS, category.name), { withFileTypes: true });
      // file nằm thẳng trong thư mục danh mục: sai chỗ
      if (entries.some((e) => e.isFile())) report.orphanFolders.push(`${category.name}/ (có file nằm ngoài thư mục mã sản phẩm)`);
      for (const entry of entries) {
        if (entry.isDirectory() && !expected.has(`${category.name}/${entry.name}`)) {
          report.orphanFolders.push(`${category.name}/${entry.name}`);
        }
      }
    }
  }
  return report;
}

module.exports = { syncProductMedia, syncAllMedia, mediaReport };
