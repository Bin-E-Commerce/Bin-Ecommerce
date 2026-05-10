# Message Broker (Kafka) — Khi nào dùng?

> Áp dụng cho: Kafka KRaft 3.7 trong hệ thống Bin E-Commerce

---

## Message Broker là gì?

**Message broker** là trung gian giữa các services — service A **publish** event, service B **subscribe** và xử lý. Hai bên **không cần biết nhau**.

```
                    ┌─────────────┐
Service A ──────▶   │    Kafka    │  ──────▶ Service B
(producer)          │   (broker)  │          (consumer)
                    └─────────────┘
                          │
                          └──────────────▶ Service C
                                          (consumer khác)
```

**Async** — Service A publish xong là tiếp tục ngay, không chờ B hay C xử lý xong.

---

## So sánh Sync vs Async

|                     | TCP/gRPC (sync)    | Kafka (async)                    |
| ------------------- | ------------------ | -------------------------------- |
| **Service A chờ?**  | Có                 | Không                            |
| **Service B down?** | A bị lỗi theo      | A vẫn chạy, B xử lý khi recover  |
| **Coupling**        | Tight (A biết B)   | Loose (A chỉ biết topic name)    |
| **Scalability**     | Khó scale consumer | Dễ — thêm consumer vào group     |
| **Audit trail**     | Không              | ✅ Kafka lưu log                 |
| **Replay**          | Không              | ✅ Consumer đọc lại từ offset cũ |

---

## Khi nào dùng Kafka

### ✅ Nên dùng Kafka khi

**1. Không cần kết quả ngay lập tức**

```
User đặt hàng → order-service tạo đơn → DONE (trả về ngay)
                                    ↓ publish "order.created"
                              inventory-service trừ tồn kho (sau 1-2 giây)
                              notification-service gửi email xác nhận
                              shipping-service tạo phiếu giao
```

**2. Nhiều services cần phản ứng với cùng 1 event**

```
"order.created" event → inventory nhận
                      → notification nhận
                      → shipping nhận
                      → analytics nhận
```

Thêm consumer mới không ảnh hưởng producer.

**3. Cần độ bền (durability)**

```
Notification-service restart giữa chừng
→ Kafka giữ lại messages chưa xử lý
→ Service recover xong → tiếp tục xử lý từ offset cũ
→ Không mất email nào
```

**4. Cần audit log / replay**

```
Bug trong inventory-service → xử lý sai tồn kho
→ Fix bug
→ Replay lại toàn bộ "order.created" events từ 1 tuần trước
→ Tính lại tồn kho đúng
```

**5. Tải cao, cần buffer**

```
Flash sale: 10,000 đơn hàng/phút
→ order-service publish events nhanh
→ inventory-service xử lý theo tốc độ của nó (không bị overwhelm)
→ Kafka làm buffer giữa 2 services
```

---

### ❌ Không dùng Kafka khi

| Tình huống                                           | Dùng gì thay       |
| ---------------------------------------------------- | ------------------ |
| Cần response ngay (check tồn kho trước khi đặt hàng) | TCP/gRPC/HTTP      |
| Query data từ service khác                           | TCP/gRPC hoặc HTTP |
| User đang chờ kết quả (blocking UX)                  | Synchronous call   |
| Logic đơn giản trong 1 service                       | Không cần broker   |

---

## Các Kafka concepts cần biết

### Topic

Channel để publish/subscribe. Đặt tên theo `domain.action`:

```
order.created
order.cancelled
order.completed
inventory.stock_updated
inventory.stock_reserved
payment.succeeded
payment.failed
notification.email_requested
user.registered
```

### Partition

Mỗi topic chia thành N partitions — cho phép parallel processing:

```
Topic "order.created" có 3 partitions:
  Partition 0: order của user A, D, G...
  Partition 1: order của user B, E, H...
  Partition 2: order của user C, F, I...
```

**Key rule**: Messages cùng `key` (ví dụ: `userId`) luôn vào cùng partition → đảm bảo order.

### Consumer Group

Nhiều instances của cùng service tạo thành 1 group — mỗi message chỉ xử lý **1 lần** trong group:

```
Topic "order.created" (3 partitions)
Consumer group "inventory-service":
  Instance 1 → đọc partition 0
  Instance 2 → đọc partition 1
  Instance 3 → đọc partition 2
```

Nếu `notification-service` cũng subscribe → group riêng → nhận **tất cả** messages (độc lập với inventory).

### Offset

Vị trí đọc trong partition. Kafka lưu offset cho mỗi consumer group.

```
Partition 0: [msg0] [msg1] [msg2] [msg3] [msg4]
                                    ↑
                             inventory offset = 3 (đã xử lý 0,1,2)
```

---

## Kafka trong hệ thống Bin E-Commerce

### Event map

```
order-service (producer)
  └── order.created        → inventory, notification, shipping
  └── order.cancelled      → inventory (hoàn tồn kho), notification
  └── order.completed      → notification, promotion (tính điểm)

inventory-service (producer)
  └── inventory.reserved   → order (xác nhận đặt hàng thành công)
  └── inventory.failed     → order (hết hàng → cancel order)
  └── inventory.low_stock  → notification (cảnh báo admin)

payment-service (producer)
  └── payment.succeeded    → order (chuyển trạng thái)
  └── payment.failed       → order, notification

return-service (producer)
  └── return.approved      → inventory (nhập lại kho), notification
```

### Setup trong NestJS

```typescript
// services/order-service/src/app.module.ts
ClientsModule.register([{
  name: 'KAFKA_CLIENT',
  transport: Transport.KAFKA,
  options: {
    client: {
      brokers: [process.env.KAFKA_BROKERS ?? 'kafka:9092'],
    },
    producer: {
      allowAutoTopicCreation: false,  // tạo topic thủ công
    },
  },
}]),
```

```typescript
// Publish event
@Injectable()
export class OrderService {
  constructor(@Inject("KAFKA_CLIENT") private readonly kafka: ClientKafka) {}

  async createOrder(dto: CreateOrderDto): Promise<Order> {
    const order = await this.orderRepo.save({ ...dto, status: "PENDING" });

    // Publish event — không await, fire-and-forget
    this.kafka.emit("order.created", {
      key: order.userId, // partition key
      value: {
        orderId: order.id,
        userId: order.userId,
        items: order.items,
        totalAmount: order.totalAmount,
        createdAt: order.createdAt.toISOString(),
      },
    });

    return order;
  }
}
```

```typescript
// Subscribe event — inventory-service
@Controller()
export class InventoryConsumer {
  @EventPattern("order.created")
  async handleOrderCreated(
    @Payload() data: OrderCreatedEvent,
    @Ctx() context: KafkaContext,
  ): Promise<void> {
    const { offset, partition, topic } = context.getMessage();

    try {
      await this.inventoryService.reserveStock(data.orderId, data.items);
      // Kafka auto-commit offset sau khi handler return không throw
    } catch (err) {
      // Throw → Kafka retry theo retry policy
      throw err;
    }
  }
}
```

---

## Event contract — định nghĩa trong `packages/common`

```typescript
// packages/common/src/kafka/events/order.events.ts
export interface OrderCreatedEvent {
  orderId: string;
  userId: string;
  items: Array<{
    productId: string;
    quantity: number;
    price: number;
  }>;
  totalAmount: number;
  createdAt: string;
}

export const KAFKA_TOPICS = {
  ORDER_CREATED: "order.created",
  ORDER_CANCELLED: "order.cancelled",
  INVENTORY_RESERVED: "inventory.reserved",
  INVENTORY_FAILED: "inventory.failed",
  PAYMENT_SUCCEEDED: "payment.succeeded",
} as const;
```

---

## Xử lý lỗi và retry

### Dead Letter Queue (DLQ)

Nếu consumer fail liên tục → message vào DLQ để xem sau:

```typescript
// Cấu hình retry trong consumer
@EventPattern('order.created')
@KafkaRetryPolicy({ retries: 3, initialRetryTime: 1000 })
async handleOrderCreated(@Payload() data: OrderCreatedEvent) {
  // Nếu throw 3 lần → message vào topic "order.created.DLT"
}
```

### Idempotency — xử lý trùng lặp

Kafka đảm bảo **at-least-once delivery** — cùng message có thể đến 2 lần (khi consumer crash sau xử lý nhưng trước khi commit offset).

```typescript
async handleOrderCreated(data: OrderCreatedEvent): Promise<void> {
  // Kiểm tra đã xử lý chưa
  const exists = await this.processedRepo.findOne({ orderId: data.orderId });
  if (exists) return;  // idempotent check

  await this.inventoryService.reserveStock(data.items);
  await this.processedRepo.save({ orderId: data.orderId });
}
```

---

## Quyết định nhanh

```
Cần communicate giữa services?
  │
  ├─ Cần response ngay để trả về cho user?
  │     → HTTP / TCP / gRPC (synchronous)
  │
  ├─ Nhiều services cần biết về event này?
  │     → Kafka (pub/sub)
  │
  ├─ Có thể xử lý sau, không cần ngay?
  │     → Kafka
  │
  ├─ Cần retry khi downstream service down?
  │     → Kafka (durability)
  │
  └─ Tải cao, cần buffer?
        → Kafka
```
