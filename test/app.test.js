import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { proto } from '@whiskeysockets/baileys/WAProto/index.js'

import { patchSoundStickerProto, TAG_AUDIO, findField } from '../lib/sound-sticker.js'
import { validateMyInstantsUrl, extractMyInstantsFromHtml, isPrivateOrReservedIp } from '../lib/myinstants.js'
import { computeSquareCrop, convertToSticker, convertAudio, exportMp4FromSticker, webpDims, MAX_STICKER_BYTES } from '../lib/media.js'

test('Baileys protobuf field 26 (StickerMessage.audioMessage) round-trip without touching node_modules', () => {
  patchSoundStickerProto()

  const audio = proto.Message.AudioMessage.fromObject({
    url: 'https://example.invalid/audio.ogg',
    mimetype: 'audio/ogg; codecs=opus',
    seconds: 4,
    ptt: false
  })
  const sticker = proto.Message.StickerMessage.fromObject({
    url: 'https://example.invalid/sticker.webp',
    mimetype: 'image/webp',
    audioMessage: audio
  })

  const encoded = proto.Message.StickerMessage.encode(sticker).finish()
  const rawField26 = findField(encoded, 26)
  assert.ok(rawField26 && rawField26.length > 0, 'field 26 must be encoded on wire')
  assert.equal(TAG_AUDIO, 210)

  const decoded = proto.Message.StickerMessage.decode(encoded)
  assert.ok(decoded.audioMessage, 'decoded StickerMessage should expose audioMessage')
  assert.equal(decoded.audioMessage.url, audio.url)
  assert.equal(decoded.audioMessage.mimetype, 'audio/ogg; codecs=opus')
  assert.equal(decoded.audioMessage.seconds, 4)

  const obj = proto.Message.StickerMessage.toObject(sticker)
  assert.equal(obj.audioMessage.seconds, 4)
})

test('MyInstants SSRF policy & HTML extractor', () => {
  assert.equal(isPrivateOrReservedIp('127.0.0.1'), true)
  assert.equal(isPrivateOrReservedIp('10.0.0.5'), true)
  assert.equal(isPrivateOrReservedIp('192.168.1.10'), true)
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false)

  assert.throws(() => validateMyInstantsUrl('http://www.myinstants.com/instant/test/'))
  assert.throws(() => validateMyInstantsUrl('https://evil.com/media/sounds/a.mp3'))
  assert.throws(() => validateMyInstantsUrl('https://127.0.0.1/media/sounds/a.mp3'))

  const ok = validateMyInstantsUrl('https://www.myinstants.com/es/instant/bruh-123/')
  assert.equal(ok.hostname, 'www.myinstants.com')

  const html = `
    <html>
      <head><meta property="og:title" content="Bruh Sound - Myinstants"></head>
      <body>
        <button id="instant-page-button-element" data-url="/media/sounds/bruh.mp3"></button>
      </body>
    </html>
  `
  const extracted = extractMyInstantsFromHtml(html)
  assert.equal(extracted.title, 'Bruh Sound')
  assert.equal(extracted.mediaUrl, 'https://www.myinstants.com/media/sounds/bruh.mp3')
})

test('Square crop math computes exact 1:1 bounds', () => {
  const rect = computeSquareCrop(800, 400, 0.5, 0.5)
  assert.deepEqual(rect, { srcX: 200, srcY: 0, cropSide: 400, outputSize: 512 })

  const right = computeSquareCrop(800, 400, 1, 0)
  assert.deepEqual(right, { srcX: 400, srcY: 0, cropSide: 400, outputSize: 512 })
})

test('Media pipeline converts PNG + WAV to 512x512 WebP, OGG/Opus, and MP4', async () => {
  const td = await mkdtemp(join(tmpdir(), 'stiksound-test-'))
  try {
    const srcPng = join(td, 'input.png')
    const srcWav = join(td, 'tone.wav')
    const outWebp = join(td, 'out.webp')
    const outOgg = join(td, 'out.ogg')
    const outMp4 = join(td, 'out.mp4')

    // Generate 800x400 RGBA PNG
    const pngBuf = await sharp({
      create: { width: 800, height: 400, channels: 4, background: { r: 37, g: 211, b: 102, alpha: 0.9 } }
    })
      .png()
      .toBuffer()
    await writeFile(srcPng, pngBuf)

    // Generate 1.5s 16-bit PCM WAV (440 Hz sine)
    const sampleRate = 16000
    const numSamples = Math.floor(sampleRate * 1.5)
    const wav = Buffer.alloc(44 + numSamples * 2)
    wav.write('RIFF', 0)
    wav.writeUInt32LE(36 + numSamples * 2, 4)
    wav.write('WAVE', 8)
    wav.write('fmt ', 12)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(sampleRate, 24)
    wav.writeUInt32LE(sampleRate * 2, 28)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36)
    wav.writeUInt32LE(numSamples * 2, 40)
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000)
      wav.writeInt16LE(sample, 44 + i * 2)
    }
    await writeFile(srcWav, wav)

    const stickerRes = await convertToSticker(srcPng, outWebp, { fit: 'cover', cropX: 0.5, cropY: 0.5 })
    const webpStat = await stat(outWebp)
    assert.ok(webpStat.size <= MAX_STICKER_BYTES)
    assert.equal(stickerRes.frames, 1)

    const dims = webpDims(await (await import('node:fs/promises')).readFile(outWebp))
    assert.deepEqual(dims, { w: 512, h: 512 })

    const audioRes = await convertAudio(srcWav, outOgg, { startMs: 200, durationMs: 1000 })
    assert.ok(audioRes.dur >= 0.8 && audioRes.dur <= 1.2)

    await exportMp4FromSticker(outWebp, outOgg, outMp4)
    const mp4Stat = await stat(outMp4)
    assert.ok(mp4Stat.size > 1000)
  } finally {
    await rm(td, { recursive: true, force: true }).catch(() => {})
  }
})
