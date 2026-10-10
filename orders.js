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

// Hai kiểu huỷ đơn (cột cancel_stage):
//   before: huỷ trước khi giao cho bên vận chuyển, hàng còn ở shop nên cộng lại kho ngay.
//   after:  huỷ sau khi đã giao cho bên vận chuyển (khách không nhận, giao thất bại...). Hàng đang trên
//           đường hoàn về nên CHƯA cộng kho; khi shop nhận lại hàng thì gọi receiveReturn().
const CANCEL_REASONS = {
  before: ['Khách đổi ý', 'Không liên lạc được khách', 'Hết hàng', 'Trùng đơn / đặt nhầm', 'Lý do khác'],
  after: ['Khách không nhận hàng', 'Giao thất bại', 'Hàng lỗi / khách trả lại', 'Lý do khác'],
};
const cancelStageOf = (order) => (['shipping', 'done'].includes(order.status) ? 'after' : 'before');

async function restoreStock(tx, orderId) {
  for (const item of await tx.query('SELECT product_id, color_id, size, qty FROM order_items WHERE order_id = ?', [orderId])) {
    await changeStock(tx, item.product_id, item.color_id, item.size, item.qty);
  }
}

// Huỷ đơn. Đơn đã huỷ thì không làm gì (không cộng kho hai lần).
async function cancelOrder(orderId, paymentStatus = null, reason = null) {
  const order = await db.one('SELECT status FROM orders WHERE id = ?', [orderId]);
  if (!order || order.status === 'cancelled') return false;
  const stage = cancelStageOf(order);
  return db.withTransaction(async (tx) => {
    if (stage === 'before') await restoreStock(tx, orderId);
    await tx.run(`
      UPDATE orders SET status = 'cancelled', payment_status = COALESCE(?, payment_status),
        cancel_stage = ?, cancel_reason = ?, cancelled_at = (now() AT TIME ZONE 'utc')
      WHERE id = ?`, [paymentStatus, stage, reason, orderId]);
    return true;
  });
}

// Shop đã nhận lại hàng hoàn của đơn huỷ sau khi giao: cộng hàng vào kho (chỉ một lần)
async function receiveReturn(orderId) {
  return db.withTransaction(async (tx) => {
    const { rowCount } = await tx.run(`
      UPDATE orders SET returned_at = (now() AT TIME ZONE 'utc')
      WHERE id = ? AND status = 'cancelled' AND cancel_stage = 'after' AND returned_at IS NULL`, [orderId]);
    if (rowCount) await restoreStock(tx, orderId);
    return Boolean(rowCount);
  });
}

async function markPaid(orderId, ref = null) {
  await db.run(`
    UPDATE orders SET payment_status = 'paid', payment_ref = COALESCE(?, payment_ref), paid_at = (now() AT TIME ZONE 'utc')
    WHERE id = ? AND payment_status != 'paid'`, [ref, orderId]);
}

module.exports = {
  ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, CARRIERS,
  CANCEL_REASONS, cancelStageOf,
  orderCode, orderIdFromCode, shippingFee, OutOfStockError, createOrder, cancelOrder, receiveReturn, markPaid,
};
