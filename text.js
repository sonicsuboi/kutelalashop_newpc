// Bỏ dấu + viết thường để so khớp tiếng Việt ("ha noi" khớp "Hà Nội")
const fold = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();

module.exports = { fold };
