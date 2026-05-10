export interface JwtPayload {
  sub: string;
  email: string;
  roles: string[];
  preferred_username?: string; // Thêm trường preferred_username để lấy tên đăng nhập của người dùng từ token, giúp hiển thị thông tin người dùng dễ dàng hơn trong các phần khác của hệ thống
  iat: number; // Thời gian token được phát hành (issued at)
  exp: number; // Thời gian token hết hạn (expiration time)
  iss: string; // Trường issuer để xác định nguồn gốc của token, giúp đảm bảo token được phát hành bởi Keycloak của chúng ta
}
