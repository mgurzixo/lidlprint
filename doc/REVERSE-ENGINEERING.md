# Reverse engineering the Lidl Mini Pocket Printer (IAN 508705_2507)

Full teardown of the Bluetooth protocol of the **Lidl TRONIC Mini Pocket
Printer / TRONIC thermische labelprinter**, sold by Lidl (NL/BE/DE…),
imported by **Karsten International B.V.** (Amsterdam), IAN
**508705_2507**, "Pocket Printer" app (`com.printer.lidloffice`).

Target: make the printer usable **without the vendor app** — no share
intents, no API in the official app.

Sibling products on the same protocol family:

| Product | IAN | OEM model | Generation |
|---|---|---|---|
| Silvercrest Mini Pocket Printer | 470561_2407 | DP-L13 (Xiamen Print Future) | 1 |
| TRONIC Mini Pocket Printer (this one) | 508705_2507 | "A2Y", fw `V1.06LY` | 2 |
| Fichero printer (Karsten house brand) | — | — | ? |

Related but different firmware: PeriPage A6/A6+/A40 (same `10 FF …` opcode
style, documented by bitrate16/eliasweingaertner).

---

## 1. Hardware & radio facts

- Thermal, 203 dpi, 1-bit (black/white), 56 mm effective head width
  → **384 pixels/row** (448 px claimed by arithmetic, but the app uses 384;
  both fit in 56/57 mm — actual bitmaps: see §4).
- Bluetooth **Classic** with SPP (Serial Port Profile) on RFCOMM **channel 1**.
- The vendor app pairs *itself* (device never appears in Android bonded list
  before first app connect). Device advertises as `Mini Pocket Printer`.
- Generation 1 exposes BLE GATT UART services
  (`e7810a71-73ae-499d-8c15-faa9aef0c3f2` among four identical ones);
  generation 2 was only observed over classic SPP.
- USB-C: charging only per manual; gen-1 exposes a USB printer endpoint
  speaking (mostly) the same commands.

## 2. Capture method (no sniffer hardware)

1. Android phone, USB debugging on.
2. **Developer options → Bluetooth HCI snoop log**. On Nothing OS 3.5
   (Android 16) the toggle alone leaves the stack in `btsnoop_mode_empty`
   — verify with `adb logcat | grep GetBtSnoopMode`.
3. Workaround that worked here (no root): the stack still runs the
   **real-time btsnoop TCP socket on port 8872**:
   ```
   adb forward tcp:8872 tcp:8872
   nc 127.0.0.1 8872 > capture.cfa     # valid btsnoop file
   ```
   (Check `adb shell ss -tln | grep 8872`; the stream starts with the
   ASCII magic `btsnoop\0`.)
4. Print a test image from the vendor app, stop the capture.
5. `tshark -r capture.cfa -Y "btspp"` to see the serial payloads;
   the `-x` hex dump + a 60-line Python parser reconstructs the SPP stream
   (RFCOMM UIH reassembly over L2CAP, DLCI/2 = channel, credit byte on
   P/F=1 in host→printer direction).

## 3. Command set (serial bytes over SPP)

All commands are plain bytes; no escaping, no framing, no CRC at this layer
(RFCOMM handles that).

### Status & settings

| Command | Response | Notes |
|---|---|---|
| `10 FF 20 F0` | ASCII model | gen 2: `41 32 59` ("A2Y"); gen 1: "DP-L13" |
| `10 FF 20 F1` | ASCII firmware | gen 2: `56 31 2E 30 36 4C 59` ("V1.06LY"); gen 1: "V3.05" |
| `10 FF 20 F2` | ASCII serial | seen on gen 1 |
| `10 FF 50 F1` | `00 pp` | battery, `pp` = percent (BCD-ish byte, e.g. `62` = 98 %) |
| `10 FF 40` | `00` / `04` | paper sensor: 00 = present, 04 = empty |
| `10 FF 10 00 n` | — | print density: n = 0 light, 1 medium, 2 dark |
| `10 FF 12 00 n` | — | auto power-off, minutes (5/10/20/30/60 in app) |

### Print job framing

```
10 FF F1 03  00 00 00 00 00 00 00 00 00 00 00 00     begin job
<image header + deflated bitmap>                      the image
1B 4A 50                                              print & feed 80 dots (ESC J 0x50)
10 FF F1 45                                           end job → printer replies AA 0D 0A
```

`1B 4A 50` is the only standard-ESC/POS survivor in gen 2 (print & feed `n`
dots). Gen 1 additionally accepts `1D 76 30 00` (ESC/POS raster) and `0C`.

### Flow control

Printer emits single-byte ACKs (`01`) between SPP writes. Wait for them,
or pace ~20 ms/122 bytes. Ignore this and the last rows of a print get
truncated (classic failure of naive peripage senders too).

## 4. Image format — the fun part

The vendor app rasterizes **everything** (also "text" documents) to a
1-bpp bitmap client-side. The printer has no text mode. So the wire format
is:

```
1F 10 00                     magic — differentiates from gen-1's 1D 76 30 00
30                           bytes per row. Always 0x30 = 48 → 384 px/row.
hh ll                        height in ROWS, 16-bit BIG-endian
00 00                        reserved/unknown
m                            mode? observed 0x07 and 0x02
c1 c2 c3                     unknown, varies; last byte always 0x91
```

Two observed jobs:

| | frame test | "To Do List / Hello world" |
|---|---|---|
| header | `1F 10 00 30 02 3E 00 00 07 7B 28 91` | `1F 10 00 30 00 E2 00 00 02 8B 28 91` |
| rows (`hhll` BE) | `0x023E` = 574 | `0x00E2` = 226 |
| inflated size | 27 552 B = 48 × 574 ✓ | 10 848 B = 48 × 226 ✓ |

The payload after the header is **raw DEFLATE** (RFC 1951, no zlib/gzip
framing — Python `zlib.decompressobj(-15)`, JS `pako.inflateRaw`). It
inflates to the bitmap:

- 1 bit per pixel, **MSB first** within each byte,
- rows are byte-aligned (48 bytes = 384 px),
- row-major top→bottom, **bit value 1 = black** (thermal burn),
- pixel (x, y) = `(data[y*48 + x/8] >> (7 - x%8)) & 1`.

End-to-end proof: deflate of the sniffed payload rendered back to PNG
reproduces the printed dashed frame and the "To Do List : / Hello world"
printout pixel-perfectly.

**Generation 1 (DP-L13) instead** sends the bitmap uncompressed after a
classic `1D 76 30 00 xL xH yL yH` ESC/POS raster header (12 bytes/row,
240 rows for 30 mm labels). If your printer answers `"DP-L13"` to
`10 FF 20 F0`, use that format — see atctwo's post.

## 5. Open questions

- Meaning of `m`, `c1 c2 c3` header bytes (the app seems to tolerate any
  value we tried — decode works with captured headers reused verbatim).
- Whether `30` (bytes/row) can be something else than 48 (384 px). Gen-1
  hardware is 96-px labels; the 56 mm head suggests 384–448 px. Unverified
  whether the firmware accepts other widths.
- Density command vs the `m` header byte: probably redundant paths to the
  same heating setting.
- BLE GATT surface of gen 2 (was not advertising when we looked; the app
  used classic SPP).

## 6. Reproduce it yourself

Everything in this repo is MIT. The TypeScript encoder
(`src/services/printer-protocol.ts`) encodes both generations; captures
(`capture1 = dashed frame`, `capture2 = hello world`) and decoded PNGs are
in this directory for regression tests.

If you have a Fichero or another Karsten-printed model, run the §2 capture
and send the model string (`10 FF 20 F0`) + one print — PRs extending the
compatibility table are welcome.
