<div align="center">

<img src="public/logo.svg" alt="Sticker Sound Logo" width="96" height="96" />

# Sticker Sound

**Aplicación web local ligera para crear, recortar y enviar stickers con audio por WhatsApp — combina editor visual `1:1`, importación de MyInstants y envío directo mediante Baileys (`StickerMessage` campo 26).**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-25D366?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Zero External Deps](https://img.shields.io/badge/FFmpeg-Incluido%20(ffmpeg--static)-12B886?style=flat-square)](#requisitos)
[![License: MIT](https://img.shields.io/badge/License-MIT-0EA5E9?style=flat-square)](LICENSE)

</div>

---

## Características principales

- **Editor Visual `1:1` (`512×512`):**
  - Pega con `Ctrl+V`, arrastra o sube **PNG** (con transparencia), **GIF animado**, **WebP**, **JPG** o **Video** (`MP4`, `MOV`, `WebM`, `MKV`).
  - Encuadre interactivo moviendo el cursor sobre la vista previa (`cover`) o ajuste completo (`contain`).
  - Fondo **Transparente**, **Blanco**, **Negro** o **Color personalizado**.
- **Audio, MyInstants y Recortador visual:**
  - Pega cualquier enlace de **MyInstants** (descarga segura en servidor con protección SSRF), sube un archivo (`MP3`, `WAV`, `OGG`, `M4A`, `AAC`, `OPUS`, `FLAC`) o usa el audio del video.
  - Recortador visual con forma de onda en el navegador (ventana de **5 s** o **10 s**) y preescucha antes de crear el sticker.
- **Conversión automática para WhatsApp:**
  - `512×512` WebP (`≤ 500 KB`) con escalado inteligente de FPS/calidad y fallback con `sharp`.
  - Audio `OGG/Opus` mono a 48 kHz (`≤ 10 s`) guardado junto al sticker en `stickers/`.
  - Exportación opcional a **MP4** (sticker + sonido) o descarga directa del `.webp`.
- **Envío directo por WhatsApp (Baileys campo 26):**
  - Vinculación mediante **Código numérico** o **Código QR** desde el mismo panel web.
  - Parche protobuf en memoria (sin modificar `node_modules`) para inyectar `StickerMessage.audioMessage` (campo `26`, tag `210`).
  - Validación de número con `onWhatsApp()` y galería persistente para reenviar en un clic.

---

## Requisitos

- **Node.js 20+** (no requiere instalar `ffmpeg` ni `ffprobe` aparte; vienen incluidos vía npm).

## Instalación y uso

```bash
git clone https://github.com/YericoNR/sticker-sound.git
cd sticker-sound
npm install
npm start
```

Abre `http://127.0.0.1:3847` en tu navegador (o en Windows haz doble clic en `scripts/iniciar.bat`).

### Envío rápido desde terminal (opcional)

```bash
node send.js stickers/mi-sticker.webp 5491122334455
```

### Tests

```bash
npm test
```

---

## Arquitectura

```text
sticker-sound/
├── server.js              # Servidor HTTP local y API REST
├── send.js                # Cliente CLI opcional para envío directo
├── lib/
│   ├── sound-sticker.js   # Parche runtime Baileys protobuf campo 26 (audioMessage)
│   ├── media.js           # Conversión 512x512 WebP, OGG/Opus y exportación MP4
│   ├── myinstants.js      # Extractor HTML + política anti-SSRF para MyInstants
│   └── whatsapp.js        # Sesión Baileys (Código QR + Pairing Code + envío)
├── public/
│   ├── index.html         # Panel web único
│   ├── styles.css         # Estilos oscuros ligeros
│   ├── app.js             # Editor visual, waveform trimmer y galería
│   └── logo.svg           # Logo e ícono de Sticker Sound
├── scripts/iniciar.bat    # Lanzador rápido en Windows
└── test/app.test.js       # Suite de pruebas automatizadas
```

---

## Créditos e inspiración

Este proyecto unifica ideas y técnicas de tres proyectos open-source:

- [SilverFeit/StikSound](https://github.com/SilverFeit/StikSound) — UX del editor visual, recorte interactivo `1:1`, MyInstants y timeline de audio.
- [LucasInstra/passticker](https://github.com/LucasInstra/passticker) — Servidor Node ligero, escalado WebP `< 500 KB`, sidecars `.ogg` y vinculación por código numérico.
- [Leandro-Limirio/whatsapp-sound-stickers](https://github.com/Leandro-Limirio/whatsapp-sound-stickers) — Flujo PoC de `StickerMessage` con audio incorporado en Baileys, QR y validación con `onWhatsApp()`.

> **Nota:** Uso personal. El soporte de reproducción de stickers con sonido depende de la versión del cliente de WhatsApp del destinatario.

## Licencia

[MIT](LICENSE)
