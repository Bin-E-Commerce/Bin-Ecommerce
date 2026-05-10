export enum UserStatus {
  ACTIVE = "ACTIVE", // Người dùng đang hoạt động bình thường, có thể đăng nhập và sử dụng dịch vụ
  INACTIVE = "INACTIVE", // Người dùng không hoạt động, có thể do tự nguyện tạm ngưng hoặc bị hệ thống vô hiệu hóa tạm thời
  BANNED = "BANNED", // Người dùng bị cấm, không thể đăng nhập hoặc sử dụng dịch vụ do vi phạm chính sách hoặc quy định của nền tảng
}
