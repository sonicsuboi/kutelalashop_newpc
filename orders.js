// Tạo, huỷ và ghi nhận thanh toán cho đơn hàng. Tồn kho được trừ ngay khi tạo đơn
// và cộng lại khi đơn bị huỷ.
const db = require('./db');
const { stockOf, changeStock } = require('./catalog');

const ORDER_STATUS = {
  new: 'Mới',
  confirmed: 'Đã xác nhận',
  shipping: 'Đang giao',
  done: 'Hoàn tất',
  cancelled: 'Đã huỷ',
};
const PAYMENT_METHOD = { cod: 'Khi nhận hàng', bank: 'Chuyển khoản', vnpay: 'Thẻ / VNPay' };
const PAYMENT_STATUS = { unpaid: 'Chưa thanh toán', paid: 'Đã thanh toán', failed: 'Thanh toán lỗi' };

// Đơn vị vận chuyển để chọn khi giao hàng
const CARRIERS = {
  ghn: 'Giao Hàng Nhanh',
  ghtk: 'Giao Hàng Tiết Kiệm',
  vtp: 'Viettel Post',
  vnpost: 'VNPost',
  jt: 'J&T Express',
  spx: 'SPX Express',
  xe: 'Grab / Ahamove / xe ôm',
  shop: 'Shop tự giao',
};

const orderCode = (id) => `KT${String(id).padStart(5, '0')}`;
const orderIdFromCode = (code) => (/^KT(\d{5,9})$/.exec(code || '') ? Number(code.slice(2)) : 0);

// Phí vận chuyển của một đơn theo cài đặt ở trang quản trị: phí cố định, miễn phí khi tiền hàng đạt mức ship_free_from
function shippingFee(site, subtotal) {
  const fee = Number(site.ship_fee) || 0;
  const freeFrom = Number(site.ship_free_from) || 0;
  return fee && !(freeFrom && subtotal >= freeFrom) ? fee : 0;
}

class OutOfStockError extends Error {
  constructor(line, left) {
    super('Hết hàng');
    this.line = line;
    this.left = left;
  }
}

// lines: kết quả cartLines() ở server.js. customer: thông tin nhận hàng, kèm customerId (khách đã
// đăng nhập) và source (kênh đưa khách tới web) nếu có. Ném OutOfStockError nếu có dòng vượt quá số còn trong kho.
async function createOrder(lines, customer, paymentMethod) {
  const shipping = customer.shippingFee || 0;
  const total = lines.reduce((sum, line) => sum + line.subtotal, 0) + shipping;
  return db.withTransaction(async (tx) => {
    for (const line of lines) {
      const left = await stockOf(tx, line.product.id, line.colorId, line.size);
      if (left < line.qty) throw new OutOfStockError(line, left);
    }
    const { id: orderId } = await tx.one(
      `INSERT INTO orders (name, phone, address, note, total, shipping_fee, payment_method, customer_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [customer.name, customer.phone, customer.address, customer.note, total, shipping, paymentMethod,
        customer.customerId || null, customer.source || null],
    );
    for (const line of lines) {
      await tx.run(`
        INSERT INTO order_items (order_id, product_id, name, color, color_id, size, size_label, qty, price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, line.product.id, line.product.name, line.colorName, line.colorId, line.size, line.sizeLabel || null, line.qty, line.product.price]);
      await changeStock(tx, line.product.id, line.colorId, line.size, -line.qty);
    }
    return { id: orderId, total };
  });
}

// Huỷ đơn và trả hàng về kho. Đơn đã huỷ thì không làm gì (không cộng kho hai lần).
async function cancelOrder(orderId, paymentStatus = null) {
  const order = await db.one('SELECT status FROM orders WHERE id = ?', [orderId]);
  if (!order || order.status === 'cancelled') return false;
  return db.withTransaction(async (tx) => {
    for (const item of await tx.query('SELECT product_id, color_id, size, qty FROM order_items WHERE order_id = ?', [orderId])) {
      await changeStock(tx, item.product_id, item.color_id, item.size, item.qty);
    }
    await tx.run("UPDATE orders SET status = 'cancelled', payment_status = COALESCE(?, payment_status) WHERE id = ?",
      [paymentStatus, orderId]);
    return true;
  });
}

async function markPaid(orderId, ref = null) {
  await db.run(`
    UPDATE orders SET payment_status = 'paid', payment_ref = COALESCE(?, payment_ref), paid_at = (now() AT TIME ZONE 'utc')
    WHERE id = ? AND payment_status != 'paid'`, [ref, orderId]);
}

module.exports = {
  ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, CARRIERS,
  orderCode, orderIdFromCode, shippingFee, OutOfStockError, createOrder, cancelOrder, markPaid,
};
