import { proto, prepareWAMessageMedia, generateWAMessageFromContent } from '@whiskeysockets/baileys'

export const FIELD_AUDIO_MESSAGE = 26
export const TAG_AUDIO = FIELD_AUDIO_MESSAGE * 8 + 2 // 210 (field 26, wire type 2)
export const SOUND_MIME = 'audio/ogg; codecs=opus'

let patched = false

/**
 * Runtime protobuf patch for WhatsApp Sound Stickers:
 * injects field 26 (`audioMessage`) on `proto.Message.StickerMessage`
 * across encode, decode, fromObject, and toObject without modifying node_modules.
 */
export function patchSoundStickerProto() {
  if (patched) return
  patched = true

  const Sticker = proto.Message.StickerMessage
  const Audio = proto.Message.AudioMessage
  if (!Sticker || !Audio) {
    throw new Error('Baileys proto.Message.StickerMessage or AudioMessage is unavailable')
  }

  if (!Object.prototype.hasOwnProperty.call(Sticker.prototype, 'audioMessage')) {
    Sticker.prototype.audioMessage = null
  }

  const encodeOriginal = Sticker.encode
  Sticker.encode = function encode(m, w) {
    w = encodeOriginal.call(this, m, w)
    if (m && m.audioMessage != null) {
      w.uint32(TAG_AUDIO).fork()
      Audio.encode(m.audioMessage, w)
      w.ldelim()
    }
    return w
  }

  const decodeOriginal = Sticker.decode
  Sticker.decode = function decode(r, l) {
    const isRawBytes = r instanceof Uint8Array
    const startPos = !isRawBytes && r && typeof r.pos === 'number' ? r.pos : 0
    const msg = decodeOriginal.call(this, r, l)
    if (msg && !msg.audioMessage) {
      let raw = null
      if (isRawBytes) {
        raw = l === undefined ? r : r.subarray(0, l)
      } else if (r && r.buf instanceof Uint8Array) {
        const endPos = l === undefined ? r.len : startPos + l
        raw = r.buf.subarray(startPos, endPos)
      }
      if (raw) {
        const chunk = findField(raw, FIELD_AUDIO_MESSAGE)
        if (chunk) {
          msg.audioMessage = Audio.decode(chunk)
        }
      }
    }
    return msg
  }

  const fromObjectOriginal = Sticker.fromObject
  Sticker.fromObject = function fromObject(d) {
    const m = fromObjectOriginal.call(this, d)
    if (d && d.audioMessage != null) {
      if (typeof d.audioMessage !== 'object') {
        throw new TypeError('.proto.Message.StickerMessage.audioMessage: object expected')
      }
      m.audioMessage = Audio.fromObject(d.audioMessage)
    }
    return m
  }

  const toObjectOriginal = Sticker.toObject
  Sticker.toObject = function toObject(m, o) {
    const d = toObjectOriginal.call(this, m, o)
    if (m && m.audioMessage != null && Object.prototype.hasOwnProperty.call(m, 'audioMessage')) {
      d.audioMessage = Audio.toObject(m.audioMessage, o)
    }
    return d
  }
}

/**
 * Builds a single WhatsApp StickerMessage with an embedded AudioMessage (field 26).
 */
export async function buildSoundStickerMessage({ jid, userJid, stickerBuf, audioBuf, seconds, upload }) {
  patchSoundStickerProto()
  const [stickerMedia, audioMedia] = await Promise.all([
    prepareWAMessageMedia({ sticker: stickerBuf }, { upload }),
    prepareWAMessageMedia(
      {
        audio: audioBuf,
        mimetype: SOUND_MIME,
        seconds: Math.max(1, Math.round(seconds || 1)),
        ptt: false
      },
      { upload }
    )
  ])
  stickerMedia.stickerMessage.audioMessage = audioMedia.audioMessage
  return generateWAMessageFromContent(jid, stickerMedia, { userJid })
}

/**
 * Scans raw protobuf bytes without schema and returns the length-delimited chunk for `fieldId`.
 */
export function findField(bytes, fieldId) {
  let pos = 0
  const varint = () => {
    let shift = 0
    let value = 0
    while (true) {
      if (pos >= bytes.length) throw new Error('truncated varint')
      const b = bytes[pos++]
      value |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) return value
      shift += 7
      if (shift > 63) throw new Error('invalid varint')
    }
  }
  while (pos < bytes.length) {
    const tag = varint()
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 0) {
      varint()
    } else if (wire === 1) {
      pos += 8
    } else if (wire === 2) {
      const len = varint()
      const chunk = bytes.subarray(pos, pos + len)
      if (field === fieldId) return chunk
      pos += len
    } else if (wire === 5) {
      pos += 4
    } else {
      throw new Error('unexpected wire type: ' + wire)
    }
  }
  return null
}
