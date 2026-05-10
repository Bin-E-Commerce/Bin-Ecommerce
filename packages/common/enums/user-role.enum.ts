export enum UserRole {
  CUSTOMER = "CUSTOMER", // Dành cho khách hàng mua sắm trên nền tảng
  CATALOG_MANAGER = "CATALOG_MANAGER", // Quản lý danh mục sản phẩm, bao gồm thêm/sửa/xóa sản phẩm và quản lý thông tin sản phẩm
  INVENTORY_MANAGER = "INVENTORY_MANAGER", // Quản lý tồn kho, bao gồm cập nhật số lượng hàng hóa và theo dõi tình trạng kho
  ORDER_MANAGER = "ORDER_MANAGER", // Quản lý đơn hàng, bao gồm xử lý đơn hàng, cập nhật trạng thái đơn hàng và quản lý thông tin khách hàng liên quan đến đơn hàng
  SHIPPING_MANAGER = "SHIPPING_MANAGER", // Quản lý vận chuyển, bao gồm theo dõi và cập nhật trạng thái vận chuyển của đơn hàng
  PROMOTION_MANAGER = "PROMOTION_MANAGER", // Quản lý khuyến mãi, bao gồm tạo, chỉnh sửa và xóa các chương trình khuyến mãi
  RETURN_MANAGER = "RETURN_MANAGER", // Quản lý trả hàng, bao gồm xử lý yêu cầu trả hàng và hoàn tiền
  ANALYST = "ANALYST", // Phân tích dữ liệu, bao gồm tạo báo cáo và phân tích hiệu suất kinh doanh
  SUPPORT_AGENT = "SUPPORT_AGENT", // Hỗ trợ khách hàng, bao gồm giải đáp thắc mắc và xử lý khiếu nại
  ADMIN = "ADMIN", // Quản trị hệ thống, bao gồm quản lý người dùng, vai trò và quyền hạn
}

// Nhóm các vai trò liên quan đến nhân viên để dễ dàng sử dụng trong các decorator @Roles() khi cần thiết
export const STAFF_ROLES: UserRole[] = [
  UserRole.CATALOG_MANAGER,
  UserRole.INVENTORY_MANAGER,
  UserRole.ORDER_MANAGER,
  UserRole.SHIPPING_MANAGER,
  UserRole.PROMOTION_MANAGER,
  UserRole.RETURN_MANAGER,
  UserRole.ANALYST,
  UserRole.SUPPORT_AGENT,
  UserRole.ADMIN,
];
