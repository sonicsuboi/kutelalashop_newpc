// Quy tắc tính giá bán từ giá sỉ (đơn vị VND). Sửa bảng ở đây khi đổi mức cộng.
// Sản phẩm nào có giá sỉ (cột cost) thì giá bán (cột price) luôn được tính lại theo bảng này.

// Giày dép: giá sỉ từ `from` trở lên thì cộng `add`. Dưới 300.000 đều cộng 150.000.
const SHOE_TIERS = [
  { from: 500000, add: 300000 },
  { from: 400000, add: 250000 },
  { from: 300000, add: 200000 },
  { from: 0, add: 150000 },
];

// Quần áo trẻ em: dưới 100.000 cộng 40.000, từ 100.000 cộng 50.000, từ 150.000 cộng 60.000, từ 200.000 cộng 70.000.
const KIDS_TIERS = [
  { from: 200000, add: 70000 },
  { from: 150000, add: 60000 },
  { from: 100000, add: 50000 },
  { from: 0, add: 40000 },
];
const KIDS = ['be-trai', 'be-gai'];

// Kính: giá sỉ trên 500.000 thì cộng 350.000, còn lại cộng 300.000.
const glassesMarkup = (cost) => (cost > 500000 ? 350000 : 300000);

function retailPrice(category, cost) {
  if (category === 'kinh') return cost + glassesMarkup(cost);
  if (KIDS.includes(category)) return cost + KIDS_TIERS.find((tier) => cost >= tier.from).add;
  return cost + SHOE_TIERS.find((tier) => cost >= tier.from).add;
}

module.exports = { retailPrice };
