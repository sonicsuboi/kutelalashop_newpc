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
const PAYMENT_METHOD = { cod: 'Khi nhận hàng', vnpay: 'Thẻ / VNPay' };
const PAYMENT_STATUS = { unpaid: 'Chưa thanh toán', paid: 'Đã thanh toán', failed: 'Thanh toán lỗi' };

const orderCode = (id) => `KT${String(id).padStart(5, '0')}`;
const orderIdFromCode = (code) => (/^KT(\d{5,9})$/.exec(code || '') ? Number(code.slice(2)) : 0);

class OutOfStockError extends Error {
  constructor(line, left) {
    super('Hết hàng');
    this.line = line;
    this.left = left;
  }
}

// lines: kết quả cartLines() ở server.js. Ném OutOfStockError nếu có dòng vượt quá số còn trong kho.
function createOrder(lines, customer, paymentMethod) {
  const total = lines.reduce((sum, line) => sum + line.subtotal, 0);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const line of lines) {
      const left = stockOf(line.product.id, line.colorId, line.size);
      if (left < line.qty) throw new OutOfStockError(line, left);
    }
    const orderId = Number(db
      .prepare('INSERT INTO orders (name, phone, address, note, total, payment_method) VALUES (?, ?, ?, ?, ?, ?)')
      .run(customer.name, customer.phone, customer.address, customer.note, total, paymentMethod).lastInsertRowid);
    const addItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, name, color, color_id, size, qty, price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const line of lines) {
      addItem.run(orderId, line.product.id, line.product.name, line.colorName, line.colorId, line.size, line.qty, line.product.price);
      changeStock(line.product.id, line.colorId, line.size, -line.qty);
    }
    db.exec('COMMIT');
    return { id: orderId, total };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Huỷ đơn và trả hàng về kho. Đơn đã huỷ thì không làm gì (không cộng kho hai lần).
function cancelOrder(orderId, paymentStatus = null) {
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status === 'cancelled') return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of db.prepare('SELECT product_id, color_id, size, qty FROM order_items WHERE order_id = ?').all(orderId)) {
      changeStock(item.product_id, item.color_id, item.size, item.qty);
    }
    db.prepare("UPDATE orders SET status = 'cancelled', payment_status = COALESCE(?, payment_status) WHERE id = ?")
      .run(paymentStatus, orderId);
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function markPaid(orderId, ref = null) {
  db.prepare(`
    UPDATE orders SET payment_status = 'paid', payment_ref = COALESCE(?, payment_ref), paid_at = datetime('now')
    WHERE id = ? AND payment_status != 'paid'`).run(ref, orderId);
}

module.exports = {
  ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS,
  orderCode, orderIdFromCode, OutOfStockError, createOrder, cancelOrder, markPaid,
};
