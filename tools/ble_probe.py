#!/usr/bin/env python3
"""ble_probe.py — scan, connect, probe the Mini Pocket Printer over BLE.

Usage:
  python3 tools/ble_probe.py scan    # 12s LE scan via callback (robust)
  python3 tools/ble_probe.py probe   # connect + GATT table + model query
"""
import asyncio
import sys

PRINTER_NAMES = ("Mini Pocket Printer",)
MODEL_QUERY = bytes.fromhex("10ff20f0")
NUS_WRITE = "49535343-8841-43f4-a8d4-ecbe34729bb3"
NUS_NOTIFY = "49535343-1e4d-4bd9-ba61-23c647249616"

found: dict[str, str] = {}  # address -> name


def _name_of(adv) -> str:
    # AdvertisementData.local_name (str | None); fall back to BLEDevice.name
    return adv.local_name or ""


async def scan():
    from bleak import BleakScanner

    def cb(device, adv):
        name = _name_of(adv) or (device.name or "")
        if name:
            found[device.address] = name
            print(f"  {device.address}  {name}  {adv.rssi}dBm")

    print("scanning 12s (callback mode)…")
    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()
    await asyncio.sleep(12)
    await scanner.stop()

    hits = {a: n for a, n in found.items() if any(p in n for p in PRINTER_NAMES)}
    if hits:
        addr, name = next(iter(hits.items()))
        print(f"\nPRINTER: {addr} ({name})")
    else:
        print(f"\nprinter not found among {len(found)} named devices")


async def probe():
    from bleak import BleakScanner, BleakClient

    def cb(device, adv):
        name = _name_of(adv) or (device.name or "")
        if name:
            found[device.address] = name

    print("scanning for printer…")
    scanner = BleakScanner(detection_callback=cb)
    await scanner.start()
    for _ in range(24):  # up to 12s
        await asyncio.sleep(0.5)
        if any(any(p in n for p in PRINTER_NAMES) for n in found.values()):
            break
    await scanner.stop()

    target_addr = next(
        (a for a, n in found.items() if any(p in n for p in PRINTER_NAMES)), None
    )
    if not target_addr:
        print(f"printer not found among {len(found)} named devices")
        return
    print(f"connecting {target_addr} ({found[target_addr]})…")
    replies = []

    def on_notify(handle, data):
        print(f"  notify: {data.hex(' ')}")
        replies.append(data)

    async with BleakClient(target_addr) as client:
        print("connected. services:")
        for svc in client.services:
            print(f"  SERVICE {svc.uuid}")
            for c in svc.characteristics:
                print(f"    {c.uuid}  [{','.join(c.properties)}]")
        print("\nsending model query 10ff20f0 on NUS write char…")
        try:
            await client.start_notify(NUS_NOTIFY, on_notify)
            await asyncio.sleep(1.0)
            await client.write_gatt_char(NUS_WRITE, MODEL_QUERY, response=True)
            await asyncio.sleep(2.0)
        finally:
            try:
                await client.stop_notify(NUS_NOTIFY)
            except Exception:
                pass
        print(f"\nreplies: {[r.hex() for r in replies]}")
        if any(b"A2Y" in r for r in replies):
            print("*** MODEL A2Y CONFIRMED over BLE from vroum ***")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "scan"
    asyncio.run(scan() if mode == "scan" else probe())
