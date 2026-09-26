# lidlprint

Direct printing to Lidl/Silvercrest **Mini Pocket Printer** (and siblings) from
your own app — no vendor app required.

**Status: protocol fully reverse-engineered and verified against live traffic.
Android app in progress.**

## What printers does this cover?

Any Lidl / Karsten International pocket printer of the 2024–2025 generations,
including:

- **Lidl IAN 470561_2407** — Silvercrest Mini Pocket Printer (Bluetooth 5.0,
  roll paper, 203 dpi) — torn down by [atctwo](https://atctwo.net/posts/2024/07/16/thermal-printer.html),
  OEM: Xiamen Print Future Technology, model **DP-L13**, app `com.printer.lidloffice`
  ("Pocket Printer" by Karsten International B.V.)
- **Lidl IAN 508705_2507** — TRONIC Mini Pocket Printer / TRONIC thermische
  labelprinter (Bluetooth 5.3, 203 dpi) — *this project's target*. OEM hardware
  reports model **A2Y**, firmware `V1.06LY`.
- The same "Pocket Printer" Android/iOS app also drives the **Fichero** branded
  printers — likely the same protocol family (not yet verified).

Both generations speak the same custom `10 FF …` command dialect over
**Bluetooth Classic SPP** (RFCOMM). This printer does **not** support ESC/POS
(except the raster-bitmap command of generation 1) and **not** BLE GATT.
The vendor app rasterizes everything (text included) to a 1-bit bitmap
client-side; there is no text mode on the printer.

## Why?

The vendor app can't receive Android share intents and has no API. With the
protocol documented here you can print from Tasker, scripts, your own app —
or from this project's app (see roadmap below).

## The protocol

Transport: **Bluetooth Classic, SPP (RFCOMM channel 1)**, plain serial bytes.

> Generation 1 (DP-L13) also exposes four redundant BLE GATT UART-style
> services, one of them the well-known `e7810a71-73ae-499d-8c15-faa9aef0c3f2`.
> Our generation-2 unit (A2Y) was only observed on classic SPP.

### Status / control commands

| Bytes | Direction | Meaning | Response (example) |
|---|---|---|---|
| `10 FF 20 F0` | host → printer | get model | `"A2Y"` (gen 1: `"DP-L13"`) |
| `10 FF 20 F1` | host → printer | get firmware | `"V1.06LY"` (gen 1: `"V3.05"`) |
| `10 FF 20 F2` | host → printer | get serial number | gen 1: `"L1324144345"` |
| `10 FF 50 F1` | host → printer | battery % | `00 62` = 98 % |
| `10 FF 40` | host → printer | paper sensor | `00` = paper, `04` = no paper |
| `10 FF 10 00 n` | host → printer | print density (`n` 0=light 1=medium 2=thick) | — |
| `10 FF 12 00 n` | host → printer | auto-off timeout in minutes | — |

### Print job sequence

| Step | Bytes | Meaning |
|---|---|---|
| 1 | `10 FF F1 03` + 12 × `00` | begin print job / flush |
| 2 | `1F 10 00 30 hh ll 00 00 m c1 c2 c3` + payload | image (see header below) |
| 3 | `1B 4A 50` | ESC J 0x50 — print & feed 80 dots |
| 4 | `10 FF F1 45` | end job — printer answers `AA 0D 0A` when ready |

### Image payload — generation 2 (A2Y, this project)

Header (12 bytes):

```
1F 10 00     magic
30           bytes per row (48 = 384 pixels, full print-head width @ 203 dpi)
hh ll        bitmap height in rows, 16-bit BIG-endian
00 00        unknown / reserved
m            unknown, observed 0x07 and 0x02 (mode? dither setting?)
c1 c2 c3     unknown, varies; last byte always 0x91 (probably checksum)
```

The payload is a **raw DEFLATE stream** (zlib `wbits=-15`, no zlib/gzip
framing) that inflates to the 1-bpp bitmap: **MSB-first**, row-major,
`bit=1` = black. Verified end-to-end: deflating sniffed traffic reproduces
the printed image pixel-perfectly.

Generation 1 (DP-L13) instead uses the classic ESC/POS raster command
`1D 76 30 00 xL xH yL yH` + uncompressed bitmap — see
[atctwo's write-up](https://atctwo.net/posts/2024/07/16/thermal-printer.html).

### Flow control

The printer ACKs with single `01` bytes between RFCOMM/SPP writes. A reliable
sender waits for these ACKs (or paces writes at ~20 ms per 122-byte chunk)
and checks `10 FF F1 45` → `AA 0D 0A` before declaring a job done.

### Example minimal print (TypeScript)

See [`src/services/printer-protocol.ts`](src/services/printer-protocol.ts) —
the protocol layer of this app, standalone and dependency-free.

## How we got here (method)

1. Android **Developer options → Bluetooth HCI snoop log** (Nothing OS pins
   it to "filtered" mode; on some builds the real-time btsnoop TCP socket on
   port 8872 still streams full H4 captures — `adb forward tcp:8872 tcp:8872`
   + netcat, no root needed).
2. One print per test image from the vendor app, capture in Wireshark /
   tshark, dissect `btspp` layer.
3. Reconstruct the SPP byte stream, spot the repeated `10 FF …` opcodes.
4. The 1910–1916-byte high-entropy blobs after `1F 10 00` turned out to be
   raw-DEFLATE (`zlib.decompressobj(-15)` → 27 KB of clean 1-bpp bitmap).
5. Verified by rendering the decoded bitmaps: pixel-perfect match with what
   the printer produced.

The captures and decoded images live in
[`doc/`](doc/) for reference.

## App (roadmap)

- [x] Protocol decode + verification
- [ ] `printer-protocol.ts` — protocol encoder (pure TS, tested against captures)
- [ ] `raster.ts` — image → 384 px → Floyd–Steinberg dither → 1-bpp MSB pack
- [ ] Capacitor plugin wiring: Bluetooth Classic SPP + share-intent receiver
- [ ] Print preview & density control
- [ ] Play Store release

**Android only** — iOS has no Bluetooth Classic API (Apple MFi wall) and
Web Bluetooth cannot do SPP, so neither a PWA nor iOS can ever reach this
printer.

## Related work

- [atctwo — Reverse Engineering a Thermal Label Printer](https://atctwo.net/posts/2024/07/16/thermal-printer.html)
  (Lidl IAN 470561_2407, DP-L13, gen-1 protocol)
- [bitrate16/peripage-python](https://github.com/bitrate16/peripage-python) —
  PeriPage A6/A6+/A40, same `10 FF …` opcode family
- [eliasweingaertner/peripage-A6-bluetooth](https://github.com/eliasweingaertner/peripage-A6-bluetooth)

## License

MIT — see [LICENSE](LICENSE).
