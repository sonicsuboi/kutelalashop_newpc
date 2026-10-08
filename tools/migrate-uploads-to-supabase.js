// Chạy 1 lần: node tools/migrate-uploads-to-supabase.js
// Tải toàn bộ ảnh/video hiện có trong public/uploads/<danh mục>/<mã>/ lên bucket
// Supabase Storage (giữ đúng prefix), rồi đồng bộ product_images cho các sản phẩm
// đã có trong database. Không tạo sản phẩm mới — mã nào chưa có sản phẩm tương ứng
// thì ảnh vẫn nằm trong bucket, chờ tạo sản phẩm cùng mã ở trang quản trị.
const fs = require('node:fs');
const path = require('node:path');
const storage = require('../storage');
const db = require('../db');
const { syncAllMedia } = require('../media');

const UPLOADS = path.join(__dirname, '..', 'public', 'uploads');

async function main() {
  if (!fs.existsSync(UPLOADS)) {
    console.log('Không có thư mục public/uploads, không có gì để chuyển.');
    return;
  }
  let count = 0;
  for (const category of fs.readdirSync(UPLOADS, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryDir = path.join(UPLOADS, category.name);
    for (const codeDir of fs.readdirSync(categoryDir, { withFileTypes: true })) {
      if (!codeDir.isDirectory()) continue;
      const dir = path.join(categoryDir, codeDir.name);
      for (const file of fs.readdirSync(dir)) {
        const filePath = path.join(dir, file);
        if (!fs.statSync(filePath).isFile()) continue;
        const key = `${category.name}/${codeDir.name}/${file}`;
        const buffer = fs.readFileSync(filePath);
        await storage.upload(key, buffer, { upsert: true });
        console.log('Đã tải lên:', key);
        count++;
      }
    }
  }
  console.log(`\nXong, đã tải ${count} file lên bucket "${storage.BUCKET}".`);

  console.log('\nĐồng bộ product_images cho các sản phẩm đã có trong database...');
  await syncAllMedia();
  console.log('Xong.');
  await db.pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
