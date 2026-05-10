# TCP vs gRPC — Khi nào dùng cái nào?

> Áp dụng cho: NestJS microservices trong hệ thống Bin E-Commerce

---

## Tổng quan

Cả TCP và gRPC đều là **synchronous communication** — service A gọi service B và **chờ** response. Khác với message broker (async).

```
Client → Service A ──[TCP/gRPC]──▶ Service B
                   ◀─────────────── response
```

---

## TCP Transport (NestJS built-in)

### Cách hoạt động

NestJS TCP transport dùng **JSON over raw TCP socket**. Không phải HTTP.

```typescript
// Service B — lắng nghe
@MessagePattern('get_user')
async getUser(@Payload() data: { id: string }) {
  return this.userService.findById(data.id);
}

// Service A — gọi
const user = await this.client.send('get_user', { id: '123' }).toPromise();
```

Kết nối:

```
Service A ──[raw TCP socket, JSON payload]──▶ Service B:4001
```

### Khi nào dùng TCP

| Tình huống                                | Lý do                         |
| ----------------------------------------- | ----------------------------- |
| Internal service-to-service call đơn giản | Setup nhanh, không cần schema |
| Prototype / MVP                           | Không cần config nhiều        |
| Payload nhỏ, không cần type safety cao    | JSON đủ dùng                  |
| Team chưa quen gRPC/Protobuf              | Learning curve thấp           |

### Ví dụ trong hệ thống

```
order-service cần kiểm tra tồn kho trước khi tạo đơn hàng:

order-service ──TCP──▶ inventory-service
  send('check_stock', { productId, quantity })
  ◀── { available: true, currentStock: 50 }
```

### Setup

```typescript
// inventory-service/src/main.ts — thêm microservice listener
app.connectMicroservice<MicroserviceOptions>({
  transport: Transport.TCP,
  options: { host: "0.0.0.0", port: 4005 },
});
await app.startAllMicroservices();

// order-service/src/app.module.ts — đăng ký client
ClientsModule.register([
  {
    name: "INVENTORY_SERVICE",
    transport: Transport.TCP,
    options: { host: "inventory-service", port: 4005 },
  },
]);
```

### Nhược điểm TCP

- **Không có schema** — payload có thể sai type mà không biết lúc compile
- **Không có versioning** — thay đổi `@MessagePattern` string là breaking change
- **Chỉ JSON** — serialize/deserialize chậm hơn binary
- **Không có code generation** — phải tự định nghĩa interface ở cả 2 phía

---

## gRPC

### Cách hoạt động

gRPC dùng **Protocol Buffers (protobuf)** — binary format, schema-first. HTTP/2 underneath.

```protobuf
// inventory.proto — contract giữa 2 services
syntax = "proto3";

service InventoryService {
  rpc CheckStock (CheckStockRequest) returns (CheckStockResponse);
  rpc GetProduct (GetProductRequest) returns (Product);
  rpc ListProducts (ListProductsRequest) returns (stream Product);  // streaming!
}

message CheckStockRequest {
  string product_id = 1;
  int32 quantity = 2;
}

message CheckStockResponse {
  bool available = 1;
  int32 current_stock = 2;
}
```

NestJS tự generate TypeScript types từ `.proto` file — **type-safe ở cả 2 phía**.

### Khi nào dùng gRPC

| Tình huống                                        | Lý do                                              |
| ------------------------------------------------- | -------------------------------------------------- |
| **High-frequency calls** giữa services            | Binary protocol nhanh hơn JSON 3-10x               |
| Cần **type safety nghiêm ngặt**                   | Protobuf schema = contract cứng                    |
| **Streaming** data lớn (danh sách sản phẩm, logs) | gRPC hỗ trợ server/client/bi-directional streaming |
| **Nhiều ngôn ngữ** (polyglot)                     | `.proto` generate code cho Go, Java, Python, v.v.  |
| API nội bộ cần **versioning**                     | `proto3` có backward compatibility rules           |
| Băng thông hạn chế                                | Protobuf nhỏ hơn JSON ~30-50%                      |

### Ví dụ trong hệ thống

```
product-service phải trả về danh sách 1000 sản phẩm cho search-service:

❌ TCP/JSON:  serialize 1000 objects → JSON string lớn → chậm
✅ gRPC:     binary stream từng product → nhanh hơn đáng kể

product-service ──gRPC streaming──▶ search-service
  rpc ListProducts(filter) returns (stream Product)
```

### Setup

```typescript
// services/product-service/src/proto/product.proto
// services/product-service/src/main.ts
app.connectMicroservice<MicroserviceOptions>({
  transport: Transport.GRPC,
  options: {
    package: 'product',
    protoPath: join(__dirname, 'proto/product.proto'),
    url: '0.0.0.0:5002',
  },
});

// order-service — gọi product-service qua gRPC
@GrpcMethod('ProductService', 'GetProduct')
```

---

## So sánh TCP vs gRPC

| Tiêu chí        | TCP (NestJS)           | gRPC                             |
| --------------- | ---------------------- | -------------------------------- |
| **Setup**       | 5 phút                 | 30 phút (cần .proto)             |
| **Type safety** | Manual (interface)     | Auto-generated từ proto          |
| **Performance** | Trung bình (JSON)      | Cao (binary protobuf)            |
| **Streaming**   | Không                  | ✅ (4 kiểu)                      |
| **Versioning**  | Khó                    | Built-in (proto backward compat) |
| **Debugging**   | Dễ (JSON readable)     | Khó hơn (binary)                 |
| **Polyglot**    | Khó                    | ✅                               |
| **Phù hợp với** | Internal, simple calls | High-perf, complex contracts     |

---

## Quyết định nhanh

```
Cần gọi service khác synchronously?
  │
  ├─ Payload < 10KB, call < 100/s, team nhỏ?
  │     → TCP (đơn giản, đủ dùng)
  │
  ├─ Payload lớn, call > 1000/s, hoặc cần streaming?
  │     → gRPC
  │
  └─ Cần nhiều ngôn ngữ trong tương lai?
        → gRPC (đầu tư proto từ đầu)
```

---

## Trong hệ thống Bin E-Commerce — Đề xuất

| Call                                | Protocol                                | Lý do                 |
| ----------------------------------- | --------------------------------------- | --------------------- |
| order → inventory (check stock)     | **TCP**                                 | Đơn giản, payload nhỏ |
| order → product (get price)         | **TCP**                                 | Đơn giản              |
| gateway → auth (verify user nội bộ) | **Không dùng** — dùng X-User-\* headers |                       |
| product → search index sync         | **gRxfka** (xem file riêng)             | Async, decoupled      |

> **Lưu ý với hệ thống hiện tại**: Đang dùng HTTP proxy qua api-gateway. TCP/gRPC chỉ nên thêm vào khi có nhu cầu **service-to-service** trực tiếp mà không qua gateway.
