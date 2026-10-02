/**
 * Pairing relay topics the daemon publishes and `ravi instances connect` waits on.
 *
 * WhatsApp keeps `ravi.whatsapp.qr|connected.<uuid>`; every legacy-bridge channel
 * type (Telegram, Discord) uses `ravi.bridge.qr|connected.<uuid>`.
 */

import { isWhatsAppChannelType } from "../whatsapp/contract.js";

export function whatsappQrTopic(instanceId: string): string {
  return `ravi.whatsapp.qr.${instanceId}`;
}

export function whatsappConnectedTopic(instanceId: string): string {
  return `ravi.whatsapp.connected.${instanceId}`;
}

export function bridgeQrTopic(instanceId: string): string {
  return `ravi.bridge.qr.${instanceId}`;
}

export function bridgeConnectedTopic(instanceId: string): string {
  return `ravi.bridge.connected.${instanceId}`;
}

/** isWhatsAppChannelType(channelType) → whatsapp topics, everything else → bridge topics. */
export function pairingTopicsFor(channelType: string, instanceId: string): { qr: string; connected: string } {
  if (isWhatsAppChannelType(channelType)) {
    return { qr: whatsappQrTopic(instanceId), connected: whatsappConnectedTopic(instanceId) };
  }
  return { qr: bridgeQrTopic(instanceId), connected: bridgeConnectedTopic(instanceId) };
}
