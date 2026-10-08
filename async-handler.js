// Express 4 không tự bắt lỗi (Promise rejection) ném ra từ route handler async;
// bọc handler bằng hàm này để lỗi được chuyển tới next(err) như handler đồng bộ.
module.exports = (fn) => (req, res, next) => fn(req, res, next).catch(next);
