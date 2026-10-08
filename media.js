// Ảnh và video sản phẩm nằm trong bucket Supabase Storage, prefix theo danh mục rồi tới mã sản phẩm:
//
//   <danh mục>/<mã sản phẩm>/        vd: bup-be/KRM7633/
//
// Database (bảng product_images) chỉ lưu URL công khai tới file, không lưu nội dung file.
// Các hàm dưới đây liệt kê bucket rồi ghi/xoá các dòng tương ứng, nên chỉ cần tải file lên là xong.
//
// Quy ước tên file:
//   - Thứ tự hiển thị theo tên file (01.jpg, 02.jpg, ...). Ảnh đầu tiên là ảnh đại diện.
//   - File bắt đầu bằng tên màu không dấu viết liền (nau-1.jpg, den-2.jpg, naubo-1.jpg)
//     được gắn với màu đó: khách chọn màu thì nhảy tới ảnh của màu.
//   - Video: .mp4, .webm hoặc .mov (video quay bằng iPhone). Ở trang chi tiết video luôn hiện đầu tiên, trước các ảnh.
const path = require('node:path');
const db = require('./db');
const { fold } = require('./text');
const storage = require('./storage');

const KINDS = { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.mp4': 'video', '.webm': 'video', '.mov': 'video' };
const kindOf = (file) => KINDS[path.extname(file).toLowerCase()];

// Mã sản phẩm dùng làm tên thư mục nên chỉ nhận chữ, số, gạch ngang, gạch dưới
const validCode = (code) => typeof code === 'string' && /^[A-Za-z0-9_-]+$/.test(code);

const prefixOf = (product) => `${product.category}/${product.code}/`;

async function syncProductMedia(product) {
  if (!validCode(product.code)) return;
  const prefix = prefixOf(product);

  const files = (await storage.list(prefix)).filter(kindOf).sort();
  const rows = await db.query('SELECT id, url FROM product_images WHERE product_id = ?', [product.id]);
  const known = new Set(rows.map((r) => r.url));
  const wanted = new Set(files.map((f) => storage.publicUrl(prefix + f)));

  // Dòng trỏ tới file trong bucket mà không còn ở prefix của sản phẩm thì bỏ
  // (file đã xoá, hoặc sản phẩm đã đổi mã). Link ngoài (http...) không thuộc bucket này vẫn được giữ.
  for (const row of rows) {
    if (row.url.startsWith(storage.publicUrl(prefix)) && !wanted.has(row.url)) {
      await db.run('DELETE FROM product_images WHERE id = ?', [row.id]);
    }
  }

  const colors = await db.query('SELECT id, name FROM product_colors WHERE product_id = ?', [product.id]);
  const colorOf = (file) => {
    const start = file.toLowerCase().split(/[-_.]/)[0];
    const match = colors.find((c) => fold(c.name).replace(/\s+/g, '') === start);
    return match ? match.id : null;
  };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const url = storage.publicUrl(prefix + file);
    if (known.has(url)) {
      await db.run('UPDATE product_images SET sort = ? WHERE product_id = ? AND url = ?', [i, product.id, url]);
    } else {
      await db.run('INSERT INTO product_images (product_id, url, kind, color_id, sort) VALUES (?, ?, ?, ?, ?)',
        [product.id, url, kindOf(file), colorOf(file), i]);
    }
  }

  // Ảnh đại diện: ảnh đầu tiên trong bucket, nếu sản phẩm chưa có hoặc ảnh cũ không còn
  const cover = files.find((f) => kindOf(f) === 'image');
  const coverGone = product.image_url && product.image_url.startsWith(storage.publicUrl(prefix)) && !wanted.has(product.image_url);
  if (cover && (!product.image_url || coverGone)) {
    const url = storage.publicUrl(prefix + cover);
    await db.run('UPDATE products SET image_url = ? WHERE id = ?', [url, product.id]);
    product.image_url = url;
  }
}

async function syncAllMedia() {
  for (const product of await db.query('SELECT * FROM products WHERE code IS NOT NULL')) {
    await syncProductMedia(product);
  }
}

// Bảng kiểm tra: sản phẩm nào chưa có mã / chưa có ảnh (dùng ở tools/kiem-tra-anh.js).
// orphanFolders luôn rỗng: không còn cách rẻ để quét "mọi prefix trong bucket không thuộc sản phẩm nào"
// như khi ảnh còn nằm trên đĩa cục bộ, nên bỏ qua kiểm tra này.
async function mediaReport() {
  const products = await db.query('SELECT id, code, name, category FROM products ORDER BY category, code');
  const report = { byCategory: {}, noCode: [], badCode: [], noMedia: [], orphanFolders: [], totalFiles: 0, totalBytes: 0 };

  for (const product of products) {
    const stats = (report.byCategory[product.category] ||= { products: 0, withMedia: 0, files: 0 });
    stats.products++;
    if (!product.code) { report.noCode.push(product); continue; }
    if (!validCode(product.code)) { report.badCode.push(product); continue; }
    const entries = await storage.listWithSize(prefixOf(product));
    const files = entries.filter((e) => kindOf(e.name));
    if (!files.length) { report.noMedia.push(product); continue; }
    stats.withMedia++;
    stats.files += files.length;
    report.totalFiles += files.length;
    report.totalBytes += files.reduce((sum, f) => sum + (f.size || 0), 0);
  }
  return report;
}

module.exports = { syncProductMedia, syncAllMedia, mediaReport, prefixOf };
