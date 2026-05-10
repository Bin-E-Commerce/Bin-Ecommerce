# Vào psql shell
docker exec -it bin_postgres psql -U bin_ecommerce

# Hoặc vào thẳng 1 DB cụ thể
docker exec -it bin_postgres psql -U bin_ecommerce -d bin_ecommerce_auth

-- Xem tất cả databases
\l

-- Kết nối vào DB khác
\c bin_ecommerce_auth

-- Xem tất cả tables trong DB hiện tại
\dt

-- Xem cấu trúc 1 table
\d users
\d refresh_tokens

-- Xóa table (nếu cần)
DROP TABLE users CASCADE;
DROP TABLE refresh_tokens CASCADE;

-- Xem dữ liệu
SELECT * FROM users;
SELECT * FROM users LIMIT 10;
SELECT id, email, role, status, created_at FROM users;

-- Thoát
\q