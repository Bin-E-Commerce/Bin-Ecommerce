export const NotificationEvents = {
  OTP_REQUESTED: "notification.otp-requested",
} as const;

export type NotificationEventType =
  (typeof NotificationEvents)[keyof typeof NotificationEvents];

export interface OtpRequestedPayload {
  email: string;
  otp: string;
  purpose: "REGISTER" | "RESET_PASSWORD" | "LOGIN";
  expiresIn: number; // seconds
}
