// Chạy: npm run kiem-tra-anh
// In bảng kiểm tra ảnh/video trong bucket Supabase Storage: mỗi danh mục có bao nhiêu sản phẩm
// đã có ảnh, sản phẩm nào còn thiếu.
const { syncAllMedia, mediaReport } = require('../media');

(async () => {
  await syncAllMedia();
  const report = await mediaReport();

  console.log('\nẢNH / VIDEO: bucket Supabase Storage, prefix <danh mục>/<mã sản phẩm>/\n');
  console.log('Danh mục'.padEnd(12), 'Sản phẩm'.padStart(9), 'Có ảnh'.padStart(8), 'Số file'.padStart(9));
  for (const [category, s] of Object.entries(report.byCategory)) {
    console.log(category.padEnd(12), String(s.products).padStart(9), String(s.withMedia).padStart(8), String(s.files).padStart(9));
  }
  console.log(`\nTổng: ${report.totalFiles} file, ${(report.totalBytes / 1024 / 1024).toFixed(1)} MB`);

  function section(title, items, format) {
    if (!items.length) return;
    console.log(`\n${title} (${items.length}):`);
    for (const item of items) console.log('  - ' + format(item));
  }
  section('Sản phẩm chưa có mã, nên chưa có ảnh', report.noCode, (p) => `#${p.id} ${p.name}`);
  section('Mã sản phẩm không hợp lệ (chỉ dùng chữ, số, - và _)', report.badCode, (p) => `#${p.id} ${p.code} ${p.name}`);
  section('Sản phẩm có mã nhưng chưa có ảnh', report.noMedia, (p) => `${p.category}/${p.code}  ${p.name}`);

  if (!report.noCode.length && !report.badCode.length && !report.noMedia.length) {
    console.log('\nMọi sản phẩm đều có ảnh.');
  }
  console.log('');
  process.exit(0);
})();
