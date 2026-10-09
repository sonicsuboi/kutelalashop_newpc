// Bật/tắt một khối theo aria-controls của nút
function bindToggle(selector, onOpen) {
  const btn = document.querySelector(selector);
  if (!btn) return;
  const target = document.getElementById(btn.getAttribute('aria-controls'));
  btn.setAttribute('aria-expanded', String(!target.hidden));
  btn.addEventListener('click', () => {
    target.hidden = !target.hidden;
    btn.setAttribute('aria-expanded', String(!target.hidden));
    if (!target.hidden && onOpen) onOpen(target);
  });
}

bindToggle('[data-toggle-filters]');
bindToggle('[data-toggle-search]', (form) => form.querySelector('input').focus());

// Menu trượt
const menu = document.getElementById('menu');
const openBtn = document.querySelector('[data-open-menu]');
function setMenu(open) {
  menu.hidden = !open;
  openBtn.setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector('[data-close-menu]').focus();
  else openBtn.focus();
}
openBtn.addEventListener('click', () => setMenu(true));
menu.addEventListener('click', (e) => {
  if (e.target === menu || e.target.closest('[data-close-menu]')) setMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menu.hidden) setMenu(false);
});

// Chân trang lộ dần phía dưới nội dung. Chỉ bật khi chân trang vừa màn hình,
// nếu không phần trên của nó sẽ không bao giờ cuộn tới được.
const header = document.querySelector('.site-header');
const footer = document.querySelector('.site-footer');
function updateFooterReveal() {
  const fits = footer.offsetHeight <= window.innerHeight - header.offsetHeight;
  footer.classList.toggle('reveal', fits);
}
updateFooterReveal();
window.addEventListener('resize', updateFooterReveal);

// Yêu thích: lưu trên trình duyệt của khách
const FAV_KEY = 'favorites';
function readFavs() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_KEY)) || []);
  } catch {
    return new Set();
  }
}
const favs = readFavs();
const cards = document.querySelectorAll('.card');
const favList = document.querySelector('[data-only-favs]');
const favEmpty = document.getElementById('fav-empty');

// Trang Yêu thích: chỉ hiện các sản phẩm đã đánh dấu
function refreshFavList() {
  if (!favList) return;
  let shown = 0;
  favList.querySelectorAll('.card').forEach((card) => {
    card.hidden = !favs.has(card.dataset.id);
    if (!card.hidden) shown++;
  });
  favEmpty.hidden = shown > 0;
}

// Báo cho máy chủ để shop đếm được số người thích từng sản phẩm
function reportFavs(ids, on) {
  if (!ids.length) return Promise.resolve();
  return fetch('/yeu-thich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ids: ids.join(','), on: on ? '1' : '0' }),
  }).catch(() => {});
}

// Đổi trạng thái yêu thích của một sản phẩm, trả về trạng thái mới
function toggleFav(id) {
  if (favs.has(id)) favs.delete(id);
  else favs.add(id);
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
  } catch {}
  reportFavs([id], favs.has(id));
  return favs.has(id);
}

// Các sản phẩm đã thích từ trước khi có tính năng đếm: báo một lần
try {
  if (favs.size && !localStorage.getItem('favorites-reported')) {
    reportFavs([...favs], true).then(() => localStorage.setItem('favorites-reported', '1'));
  }
} catch {}

cards.forEach((card) => {
  const id = card.dataset.id;
  const btn = card.querySelector('[data-fav]');
  btn.setAttribute('aria-pressed', String(favs.has(id)));
  btn.addEventListener('click', () => {
    btn.setAttribute('aria-pressed', String(toggleFav(id)));
    refreshFavList();
  });
});
refreshFavList();

// Trang chi tiết: nút yêu thích kèm số người thích
document.querySelectorAll('[data-fav-product]').forEach((btn) => {
  const id = btn.dataset.favProduct;
  const count = btn.querySelector('[data-fav-count]');
  // số máy chủ đưa về đã tính (hoặc chưa tính) khách này, nên chỉ cộng trừ phần chênh
  const base = Number(count.textContent) - (btn.dataset.counted === '1' ? 1 : 0);
  const show = () => {
    btn.setAttribute('aria-pressed', String(favs.has(id)));
    count.textContent = base + (favs.has(id) ? 1 : 0);
  };
  show();
  btn.addEventListener('click', () => {
    toggleFav(id);
    show();
  });
});

// Trang chi tiết: bộ hình sản phẩm
document.querySelectorAll('[data-gallery]').forEach((gallery) => {
  const slides = gallery.querySelectorAll('[data-slide]');
  const thumbs = gallery.querySelectorAll('[data-thumb]');
  let current = 0;
  function show(index) {
    current = (index + slides.length) % slides.length;
    slides.forEach((slide, i) => {
      slide.classList.toggle('active', i === current);
      // chuyển sang hình khác thì dừng video đang phát
      const video = slide.querySelector('video');
      if (video && i !== current) video.pause();
      // chuyển tới video thì tự phát (tắt tiếng, khách bật tiếng bằng nút trên video)
      if (video && i === current) video.play().catch(() => {});
    });
    thumbs.forEach((thumb, i) => thumb.setAttribute('aria-current', String(i === current)));
  }
  thumbs.forEach((thumb, i) => thumb.addEventListener('click', () => show(i)));
  const prev = gallery.querySelector('[data-prev]');
  const next = gallery.querySelector('[data-next]');
  if (prev) prev.addEventListener('click', () => show(current - 1));
  if (next) next.addEventListener('click', () => show(current + 1));

  // Chọn màu: đổi màu hình vẽ và tên màu đang chọn
  const colorName = document.querySelector('[data-color-name]');
  document.querySelectorAll('.buy input[name="color"]').forEach((input) => {
    input.addEventListener('change', () => {
      gallery.style.setProperty('--c', input.dataset.hex);
      gallery.style.setProperty('--s', input.dataset.sole);
      if (colorName) colorName.textContent = input.dataset.name;
      // có ảnh riêng của màu này thì nhảy tới ảnh đó
      const first = [...slides].findIndex((slide) => slide.dataset.color === input.value);
      if (first !== -1) show(first);
    });
  });
});

// Giỏ hàng: đổi số lượng là cập nhật luôn
document.querySelectorAll('[data-auto-submit]').forEach((input) => {
  input.addEventListener('change', () => input.form.submit());
});

// Trang chi tiết: số lượng còn theo màu và size đang chọn
const buy = document.querySelector('.buy[data-stock]');
if (buy) {
  const stock = JSON.parse(buy.dataset.stock);
  const note = buy.querySelector('[data-stock-note]');
  const qty = buy.querySelector('input[name="qty"]');
  const submit = buy.querySelector('button[type="submit"]');
  const sizes = [...buy.querySelectorAll('input[name="size"]')];
  const refreshStock = () => {
    const picked = buy.querySelector('input[name="color"]:checked');
    const color = picked ? picked.value : '0';
    const leftOf = (size) => stock[color + '.' + size] || 0;
    // size đã hết của màu đang chọn thì không cho chọn
    for (const input of sizes) {
      input.disabled = !leftOf(input.value);
      if (input.disabled) input.checked = false;
    }
    const size = sizes.find((input) => input.checked);
    if (sizes.length && !size) {
      const any = sizes.some((input) => !input.disabled);
      note.textContent = any ? 'Chọn size để xem số lượng còn' : 'Màu này tạm hết hàng';
      submit.disabled = !any;
      return;
    }
    const left = leftOf(size ? size.value : 0);
    note.textContent = left ? 'Còn ' + left + ' sản phẩm' : 'Tạm hết hàng';
    submit.disabled = !left;
    qty.max = Math.min(10, Math.max(left, 1));
    if (Number(qty.value) > left) qty.value = Math.max(left, 1);
  };
  buy.addEventListener('change', refreshStock);
  refreshStock();
}

// Thẻ sản phẩm: nút "Thêm vào giỏ" mở hộp chọn màu và size giống trang chi tiết
const quick = document.getElementById('quick');
if (quick && quick.showModal) {
  const form = quick.querySelector('form');
  const $ = (sel) => quick.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let data = null;

  const refresh = () => {
    const color = form.querySelector('input[name="color"]:checked');
    const colorId = color ? color.value : '0';
    if (color) $('[data-quick-color-name]').textContent = color.dataset.name;
    const leftOf = (size) => data.stock[colorId + '.' + size] || 0;
    const sizes = [...form.querySelectorAll('input[name="size"]')];
    for (const input of sizes) {
      input.disabled = !leftOf(input.value);
      if (input.disabled) input.checked = false;
    }
    const picked = sizes.find((i) => i.checked);
    const submit = form.querySelector('button[type="submit"]');
    const qty = form.querySelector('input[name="qty"]');
    if (sizes.length && !picked) {
      const any = sizes.some((i) => !i.disabled);
      $('[data-quick-note]').textContent = any ? 'Chọn size để xem số lượng còn' : 'Màu này tạm hết hàng';
      submit.disabled = !any;
      return;
    }
    const left = leftOf(picked ? picked.value : 0);
    $('[data-quick-note]').textContent = left ? 'Còn ' + left + ' sản phẩm' : 'Tạm hết hàng';
    submit.disabled = !left;
    qty.max = Math.min(10, Math.max(left, 1));
    if (Number(qty.value) > left) qty.value = Math.max(left, 1);
  };

  const open = async (slug) => {
    const res = await fetch('/san-pham/' + encodeURIComponent(slug) + '/nhanh');
    if (!res.ok) { location.href = '/san-pham/' + slug; return; }
    data = await res.json();
    form.product_id.value = data.id;
    form.qty.value = 1;
    $('[data-quick-name]').textContent = data.name;
    $('[data-quick-price]').textContent = data.price;
    $('[data-quick-link]').href = '/san-pham/' + data.slug;
    $('[data-quick-media]').innerHTML = data.image ? '<img src="' + esc(data.image) + '" alt="">' : '';
    const colors = $('[data-quick-colors]');
    colors.hidden = !data.colors.length;
    colors.querySelectorAll('label').forEach((l) => l.remove());
    data.colors.forEach((c, i) => colors.insertAdjacentHTML('beforeend',
      '<label class="swatch" title="' + esc(c.name) + '"><input type="radio" name="color" value="' + c.id + '"' + (i ? '' : ' checked') +
      ' data-name="' + esc(c.name) + '"><span style="background:' + esc(c.hex) + '"></span><span class="sr-only">' + esc(c.name) + '</span></label>'));
    const sizes = $('[data-quick-sizes]');
    sizes.hidden = !data.sizes.length;
    sizes.querySelectorAll('label').forEach((l) => l.remove());
    data.sizes.forEach((s, i) => sizes.insertAdjacentHTML('beforeend',
      '<label class="size"><input type="radio" name="size" value="' + s + '" required><span>' + esc(data.sizeLabels[i]) + '</span></label>'));
    refresh();
    quick.showModal();
  };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick]');
    if (btn) open(btn.dataset.quick);
  });
  form.addEventListener('change', refresh);
  $('[data-quick-close]').addEventListener('click', () => quick.close());
  // bấm ra ngoài hộp thì đóng
  quick.addEventListener('click', (e) => { if (e.target === quick) quick.close(); });
}

// Thêm vào giỏ không chuyển trang: gửi ngầm, ảnh sản phẩm bay vào icon giỏ, số trên icon tăng.
// Muốn xem giỏ thì bấm icon giỏ ở góc trên.
const cartIcon = document.querySelector('[data-cart-icon]');
const cartCount = document.querySelector('[data-cart-count]');

function flyToCart(fromEl) {
  if (!cartIcon || !fromEl || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const from = fromEl.getBoundingClientRect();
  const to = cartIcon.getBoundingClientRect();
  if (!from.width) return;
  const ghost = fromEl.cloneNode(true);
  ghost.className = 'fly-ghost';
  Object.assign(ghost.style, { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px' });
  document.body.appendChild(ghost);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  ghost.animate([
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
    { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(.08)', opacity: .5 },
  ], { duration: 700, easing: 'cubic-bezier(.5, -0.2, .7, 1)' }).onfinish = () => {
    ghost.remove();
    cartIcon.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 300 });
  };
}

function toast(text) {
  let box = document.querySelector('.toast');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toast';
    box.setAttribute('role', 'status');
    document.body.appendChild(box);
  }
  box.innerHTML = '';
  box.append(text + ' ');
  const link = document.createElement('a');
  link.href = '/gio-hang';
  link.textContent = 'Xem giỏ hàng';
  box.append(link);
  box.classList.add('show');
  clearTimeout(box.timer);
  box.timer = setTimeout(() => box.classList.remove('show'), 3500);
}

document.querySelectorAll('form[action="/gio-hang/them"]').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams(new FormData(form)),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || 'Chưa thêm được vào giỏ.'); return; }
      // ảnh đang hiện của sản phẩm: trong hộp chọn nhanh, hoặc ảnh lớn ở trang chi tiết
      const image = form.querySelector('.quick-media img') || document.querySelector('.gallery .slide.active img, .gallery .slide.active svg');
      const dialog = form.closest('dialog');
      flyToCart(image);
      if (dialog) dialog.close();
      if (cartCount) { cartCount.textContent = data.count; cartCount.hidden = !data.count; }
      toast('Đã thêm vào giỏ.');
    } catch {
      form.submit();
    } finally {
      button.disabled = false;
    }
  });
});
