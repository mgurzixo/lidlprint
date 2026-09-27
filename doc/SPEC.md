# LidlPrint — App Specification

Version 1.0 — approved 2026-09-26. Implementation follows this spec; changes
go through this document first.

## 1. Purpose

LidlPrint prints images on the Lidl / Silvercrest / TRONIC Mini Pocket
Printer (Karsten International, IAN 508705_2507 gen 2 "A2Y" and IAN
470561_2407 gen 1 "DP-L13") over Bluetooth Classic SPP, using the protocol
reverse-engineered in `doc/REVERSE-ENGINEERING.md`.

It is a **print spooler, not an editor**: receive an image via Android share,
preview, print. The vendor app keeps the editing role.

Primary use case: sharing a ZK: QR code rendered by zik4 without touching
zik4's code.

## 2. Platform

- Quasar (Vue 3 + TS) SPA wrapped by Capacitor, Android only.
- iOS and pure-PWA are impossible (no Bluetooth Classic API — MFi wall;
  Web Bluetooth has no SPP). Stated in README.
- No other native dependency. Deflate = `pako.deflateRaw` in JS.

## 3. Screens (single page, three zones)

```
┌──────────────────────────────────────┐
│ [Connect]  message line              │  ① banner
├──────────────────────────────────────┤
│      ┌ ⋯ 384px dashed frame ⋯ ┐      │  ② preview
│      │      preview image     │      │
│      └ ─────────────────────────┘    │
├──────────────────────────────────────┤
│ density [light|medium|dark]          │  ③ controls
│ dither  [photo|art]                  │
│           [  PRINT  ]                │  ④ print button
└──────────────────────────────────────┘
```

### 3.1 Banner

- **Connect button**, 4 states:
  - white "Connect" — disconnected
  - grey "Connecting…" — in flight, not tappable
  - green "Connected" — tap = disconnect (explicit only)
- **Message line**: ONE line, latest message wins, no scrolling log.
  - grey text = info, red = error.
  - Content examples:
    - `Ready. No printer selected.` (with a "pick" link → Settings)
    - `Connecting to Mini Pocket Printer…`
    - `Connected · Mini Pocket Printer · battery 98% · paper ok`
    - `Printing… 45%`
    - `Printed ✓`
    - `No paper.`, `Printer silent at byte 1024/3345.`, `Bluetooth is off.`
- On connect: status poll (model `10 FF 20 F0`, battery `10 FF 50 F1`,
  paper `10 FF 40`) and result shown in the message line.
- After a print completes: disconnect automatically; button back to white;
  last message stays.

### 3.2 Preview

- The received image scaled to fit width, aspect preserved, shown inside a
  dashed "paper" frame representing the 384 px head width.
- If the source is wider than the frame allows (extreme aspect), the part
  that would be lost is dimmed, not silently cropped.
- Below the frame: output size line, e.g. `prints at 384 × 574 dots`.
- No image yet: placeholder text `Share an image to LidlPrint, or pick one`.

### 3.3 Controls

- **density** chips: light / medium / dark → `10 FF 10 00 n` (n = 0/1/2).
  Default: medium. Applies at job start.
- **dither** chips: photo (Floyd–Steinberg) / art (threshold).
  Default heuristic: PNG with ≤ 64 distinct colors → art, else photo.
  QR codes / line art MUST use art: dithering destroys scanners.
- Chips are always enabled (they affect the preview at next print, not the
  connection).

### 3.4 Print button

- **Grey** (disabled) when any of: no image, not connected, paper empty,
  print already in flight. No toast when tapped disabled.
- **Blue** when all clear. Label: `Print`.
- While printing: label `Printing… x%`, still disabled.
- Print NEVER auto-connects. Banner owns the connection; button owns
  printing. One mental model.

## 4. Flows

### 4.1 Share intent (primary)

`ACTION_SEND` `image/*` (content URI) or `text/plain`:

- image → preview.
- text → rendered to bitmap: black on white, 24 px sans-serif, wrapped at
  384 px, max ~20 rows, then treated as art.

### 4.2 Direct open

Same screen with placeholder + `Pick image` affordance (photo picker).

### 4.3 Print job

1. (re)assert density if changed since connect.
2. `10 FF 40` paper check — abort with message if `04`.
3. Build bitmap per dither setting → header + `pako.deflateRaw`.
4. Send job per protocol: chunk 122 B, wait ACK (`0x01`) max 1 s per chunk
   else pace 20 ms; progress = bytes sent / total.
5. `1B 4A 50`, then `10 FF F1 45`, wait `AA 0D 0A` (max 10 s).
6. Success → `Printed ✓`, disconnect.

Any failure: message line red with the step and byte offset; job aborted
(no retry loops, no fallbacks — signal, per global rules).

### 4.4 Connection policy

Stateless per job. Connect on demand (user tap), disconnect after print or
via Connect-button tap. The printer auto-powers-off; persistent connections
are pointless.

## 5. Settings screen

- Printer: list of bonded classic-BT devices, tap to select, remembered MAC
  (Capacitor Preferences). Refresh button. Hint text: pair the printer in
  Android Bluetooth settings first; it advertises as `Mini Pocket Printer`.
- Debug protocol log toggle → dumps job bytes (hex) to logcat tag
  `lidlprint`. Off by default.
- About: MIT, link to protocol doc, printer compatibility table.

## 6. Architecture

```
src/services/printer-protocol.ts   protocol encoder + transport helpers (pure TS)
src/services/raster.ts             ImageData → 1bpp bitmap, dither/threshold (pure TS)
src/services/bt.ts                 Capacitor bridge front-end (typed API)
android/…/BluetoothClassicPlugin.kt   bonded list / connect / write / read / close
android/…/ShareIntentPlugin.kt        onNewIntent → JS event (uri|text)
```

- Both TS services are tested in Node against the two captured vendor-app
  jobs: encoder output must be byte-identical to `spp_sent.bin` (frame,
  574 rows) and `spp_sent2.bin` (hello world, 226 rows) when fed the same
  bitmaps — deflate verified by inflating both ways.
- Kotlin plugins: no business logic. The plugin does NOT understand the
  protocol; it moves bytes.

## 7. Non-goals (v1)

- iOS, PWA, Web Bluetooth.
- Editing, crop, rotate, templates, emoji.
- BLE transport (gen-1 GATT path).
- Print queue / background service / auto-reconnect loops.
- i18n (English strings hardcoded; translation pass before deploy per
  project workflow).

## 8. Acceptance

- [x] Unit: encoder byte-identical to both captured jobs.
- [x] Unit: rasterizer round-trip (solid black row → 0x00 bytes; QR sample
      stays threshold-crisp in art mode).
- [x] Device: share a PNG from zik4 → print matches preview (40 mm QR).
- [x] Device: QR from zik4 scans off the paper (art mode) — easily.
- [x] Device: banner states all reachable; grey/blue button logic exact.
- [x] Device: no-paper and printer-off produce the red messages, no crash.
- [x] Device: fresh install → Connect → system BT permission dialog → green.
