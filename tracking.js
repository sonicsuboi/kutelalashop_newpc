// Ghi lại lượt truy cập: ai (mã ngẫu nhiên trong cookie, không phải thông tin cá nhân),
// xem trang nào, và đi từ kênh nào tới (Zalo, Facebook, Google, ...).
//
// Cách nhận kênh, theo thứ tự ưu tiên:
//   1. Link có ?nguon=... hoặc ?utm_source=...  (vd: gửi khách link .../san-pham?nguon=zalo)
//   2. Trình duyệt bên trong ứng dụng (Zalo, Messenger, Facebook, Instagram, TikTok)
//   3. Trang web dẫn tới (Google, Facebook, ...), web lạ thì ghi là "khac" kèm tên miền
//   4. Không có gì thì là "truc-tiep" (gõ địa chỉ, bấm bookmark)
// Kênh của lần vào đầu được giữ trong cookie 30 phút để các trang xem tiếp theo tính chung một kênh.
const crypto = require('node:crypto');
const db = require('./db');

const SOURCES = {
  zalo: 'Zalo',
  messenger: 'Messenger',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  google: 'Google',
  coccoc: 'Cốc Cốc',
  bing: 'Bing',
  yahoo: 'Yahoo',
  duckduckgo: 'DuckDuckGo',
  'truc-tiep': 'Vào trực tiếp',
  khac: 'Web khác',
};
const sourceLabel = (key) => SOURCES[key] || key;
// Các kênh là công cụ tìm kiếm, dùng cho thống kê SEO
const SEARCH_ENGINES = ['google', 'coccoc', 'bing', 'yahoo', 'duckduckgo'];

const APPS = [
  ['zalo', /zalo/i],
  ['messenger', /messenger|FB_IAB\/MESSENGER|FBAN\/Messenger/i],
  ['facebook', /FBAN|FBAV|FB_IAB/i],
  ['instagram', /instagram/i],
  ['tiktok', /tiktok|musical_ly|bytedance/i],
];
const SITES = [
  ['zalo', /(^|\.)zalo\.(me|vn)$|(^|\.)zaloapp\.com$/],
  ['messenger', /(^|\.)messenger\.com$/],
  ['facebook', /(^|\.)(facebook\.com|fb\.com|fb\.me)$/],
  ['instagram', /(^|\.)instagram\.com$/],
  ['tiktok', /(^|\.)tiktok\.com$/],
  ['youtube', /(^|\.)(youtube\.com|youtu\.be)$/],
  ['google', /(^|\.)google\./],
  ['coccoc', /(^|\.)coccoc\.com$/],
  ['bing', /(^|\.)bing\.com$/],
  ['yahoo', /(^|\.)yahoo\./],
  ['duckduckgo', /(^|\.)duckduckgo\.com$/],
];
const BOT = /bot|crawl|spider|slurp|preview|monitor|uptime|headless|curl|wget|python|render/i;

const cookie = (req, name) => new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie || '')?.[1] || '';
const slug = (v) => (typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) : '');

// Kênh mà chính yêu cầu này cho biết; null nếu không có dấu hiệu gì (khách bấm link trong web)
function detectSource(req) {
  const tagged = slug(req.query.nguon) || slug(req.query.utm_source);
  if (tagged) return { source: tagged, referrer: null };

  const ua = req.get('user-agent') || '';
  const app = APPS.find(([, re]) => re.test(ua));
  if (app) return { source: app[0], referrer: null };

  let host = '';
  try { host = new URL(req.get('referer') || '').hostname.toLowerCase(); } catch { /* không có trang dẫn tới */ }
  if (!host || host === req.hostname) return null;
  const site = SITES.find(([, re]) => re.test(host));
  return site ? { source: site[0], referrer: host } : { source: 'khac', referrer: host };
}

// Gắn mã khách (req.visitor) và kênh (req.source) cho mọi yêu cầu; ghi một dòng vào bảng visits
// cho mỗi trang HTML mở thành công. Route nào là trang sản phẩm thì đặt res.locals.viewedProduct.
function track(req, res, next) {
  let visitor = cookie(req, 'vid');
  if (!/^[0-9a-f]{20}$/.test(visitor)) {
    visitor = crypto.randomBytes(10).toString('hex');
    res.cookie('vid', visitor, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
  }
  req.visitor = visitor;

  const found = detectSource(req);
  const kept = slug(cookie(req, 'src'));
  req.source = found ? found.source : kept || 'truc-tiep';
  res.cookie('src', req.source, { maxAge: 30 * 60 * 1000, httpOnly: true, sameSite: 'lax' });

  const isPage = req.method === 'GET' && (req.get('accept') || '').includes('text/html');
  req.isBot = BOT.test(req.get('user-agent') || '');
  if (isPage && !req.isBot) {
    res.on('finish', () => {
      if (res.statusCode !== 200) return;
      db.run('INSERT INTO visits (visitor, path, product_id, source, referrer) VALUES (?, ?, ?, ?, ?)',
        [visitor, req.path.slice(0, 200), res.locals.viewedProduct || null, req.source, found ? found.referrer : null])
        .catch((err) => console.error('Không ghi được lượt truy cập:', err.message || err.code));
    });
  }
  next();
}

module.exports = { SOURCES, SEARCH_ENGINES, sourceLabel, track };
