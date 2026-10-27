import type { PushKind } from './model.js';

/*
 * 1.9.0 (B-152): what delivery needs from devices (B-150) and preferences (B-153), which are built beside it. Delivery
 * reads them through these narrow interfaces from `s.pushDevices` and `s.notificationPrefs` when those services exist,
 * and through the stand-ins below until they do (no devices: nothing is pushed; every channel allowed now).
 *
 * The device shape is B-150's `DeliveryDevice` (platform/push-devices.ts), of which delivery reads:
 *
 *   { id, provider: 'apns' | 'fcm' | 'webpush' | 'http' | 'websocket', appId, name, token, subscription }
 *
 * - `token` (or, for `webpush`, `subscription`: the browser's `PushSubscription.toJSON()`, which `web/js/webpush.js`
 *   registers through `POST /api/me/devices`) is opened for this delivery only and never stored or logged here.
 * - `appId` is the APNs bundle id, the FCM project id or a vendor's app id; null matches a provider of the kind whose
 *   own app id is unset.
 * - `markGone(deviceId, reason)` is called when the provider says the token is gone (APNs 410 or BadDeviceToken, FCM
 *   UNREGISTERED or INVALID_ARGUMENT on the token, a mapped "token gone" from an HTTP vendor).
 */

export interface DeliveryDevice {
  id: string;
  provider: PushKind;
  appId: string | null;
  /** The opened token; null for Web Push. */
  token: string | null;
  /** The Web Push subscription; null for the other kinds. */
  subscription?: { endpoint: string; keys: { p256dh: string; auth: string } } | null;
  name?: string | null;
  platform?: string | null;
}

export interface PushDevicesPort {
  forDelivery(tenantId: string, userId: string): Promise<DeliveryDevice[]>;
  markGone(deviceId: string, reason: string): Promise<unknown>;
}

export type DeliveryChannel = 'in_app' | 'email' | 'push' | 'websocket';

export interface PreferenceDecision {
  deliver: 'now' | 'digest' | 'suppressed';
  reason: string;
}

export interface NotificationPrefsPort {
  decide(tenantId: string, userId: string, kind: string, channel: DeliveryChannel, o: { urgent: boolean }): Promise<PreferenceDecision>;
}

/** Until B-150 lands: nobody has a device. */
export const NO_DEVICES: PushDevicesPort = {
  forDelivery: async () => [],
  markGone: async () => undefined
};

/** Until B-153 lands: every channel is allowed at once. */
export const ALLOW_ALL: NotificationPrefsPort = {
  decide: async () => ({ deliver: 'now', reason: 'no preferences' })
};
