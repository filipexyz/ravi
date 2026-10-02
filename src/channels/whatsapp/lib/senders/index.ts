/**
 * Message senders
 *
 * Provides functions for building and sending various message types.
 */

// Text
export { buildTextContent, sendTextMessage } from "./text.js";

// Media (image, audio, video, document, sticker)
export {
  buildImageContent,
  buildAudioContent,
  buildVideoContent,
  buildDocumentContent,
  buildStickerContent,
  sendImageMessage,
  sendAudioMessage,
  sendVideoMessage,
  sendDocumentMessage,
  sendStickerMessage,
} from "./media.js";

// Reaction
export {
  buildReactionContent,
  sendReaction,
  removeReaction,
} from "./reaction.js";

// Location
export {
  buildLocationContent,
  sendLocationMessage,
  isValidLocation,
  type LocationData,
} from "./location.js";

// Contact
export {
  computeWaid,
  buildVCard,
  buildContactContent,
  buildMultiContactContent,
  sendContactMessage,
  sendMultiContactMessage,
  type ContactData,
} from "./contact.js";

// Forward
export { forwardMessage } from "./forward.js";

// Stream sender (progressive response edits)
export { WhatsAppStreamSender } from "./stream.js";
export type { WhatsAppStreamSenderOptions } from "./stream.js";

// Unified content builder
export { buildMessageContent } from "./builders.js";
