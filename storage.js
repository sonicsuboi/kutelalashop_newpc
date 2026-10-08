// Lưu trữ ảnh/video sản phẩm trên Supabase Storage (bucket public) thay vì
// đĩa cục bộ, để ảnh không mất khi container bị tạo lại trên host free.
const { createClient } = require('@supabase/supabase-js');

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'product-media';

// createClient kiểm tra URL ngay khi gọi (khác pg.Pool lười kết nối), nên thiếu
// .env thì dùng placeholder để app vẫn khởi động được; gọi thật tới Storage mới báo lỗi.
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder',
  { auth: { persistSession: false } },
);

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

const publicUrl = (key) => `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${key}`;

// Liệt kê toàn bộ file trong một prefix (vd: "bup-be/KRM7633/"), trang nếu vượt 1000 file.
async function list(prefix) {
  const files = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, {
      limit, offset, sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw error;
    for (const f of data) if (f.id) files.push(f.name); // f.id vắng mặt với "folder" giả
    if (data.length < limit) break;
    offset += limit;
  }
  return files;
}

// Như list(), nhưng giữ lại kích thước file (dùng cho báo cáo thống kê)
async function listWithSize(prefix) {
  const entries = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, {
      limit, offset, sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw error;
    for (const f of data) if (f.id) entries.push({ name: f.name, size: f.metadata?.size || 0 });
    if (data.length < limit) break;
    offset += limit;
  }
  return entries;
}

async function upload(key, buffer, { upsert = false } = {}) {
  const ext = key.slice(key.lastIndexOf('.')).toLowerCase();
  const { error } = await supabase.storage.from(BUCKET).upload(key, buffer, {
    contentType: CONTENT_TYPES[ext] || 'application/octet-stream',
    upsert,
  });
  if (error) throw error;
}

async function remove(keys) {
  const { error } = await supabase.storage.from(BUCKET).remove(keys);
  if (error) throw error;
}

module.exports = { BUCKET, CONTENT_TYPES, publicUrl, list, listWithSize, upload, remove };
