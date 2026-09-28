package com.gurzixo.lidlprint;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothSocket;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Capacitor bridge over Bluetooth Classic SPP.
 *
 * Moves bytes, nothing else — all protocol logic lives in the web layer
 * (src/services/printer-protocol.ts). Stateless: connect → write/read × n →
 * disconnect.
 */
@CapacitorPlugin(
    name = "BluetoothClassic",
    permissions = {
        @Permission(strings = { Manifest.permission.BLUETOOTH_CONNECT }, alias = "connect"),
        @Permission(strings = { Manifest.permission.BLUETOOTH_SCAN }, alias = "scan")
    }
)
public class BluetoothClassicPlugin extends Plugin {

    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private BluetoothSocket socket;
    private OutputStream out;
    private InputStream in;
    private final Object ioLock = new Object();

    // ---- BLE probe state (RE tooling) ----
    private final Object writeLock = new Object();
    private boolean writePending = false;
    private int writeStatus = -1;

    private BluetoothLeScanner bleScanner;
    private ScanCallback bleScanCallback;
    private BluetoothGatt bleGatt;
    private final java.util.List<JSObject> bleServices = new java.util.ArrayList<>();
    private final java.util.concurrent.ConcurrentLinkedQueue<String> bleNotifyHex =
            new java.util.concurrent.ConcurrentLinkedQueue<>();

    // ---------------------------------------------------------------- BLE probe

    /** Scan BLE advertisers (named only) for scanMs, return list. */
    @PluginMethod
    public void bleScan(PluginCall call) {
        Integer scanMs = call.getInt("scanMs", 8000);
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = bm == null ? null : bm.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("bluetooth off");
            return;
        }
        try {
            bleScanner = adapter.getBluetoothLeScanner();
        } catch (SecurityException e) {
            call.reject("scan permission: " + e.getMessage());
            return;
        }
        if (bleScanner == null) {
            call.reject("no LE scanner");
            return;
        }
        JSArray found = new JSArray();
        bleScanCallback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                BluetoothDevice d = result.getDevice();
                String name;
                try { name = d.getName(); } catch (SecurityException se) { name = null; }
                if (name == null || name.isEmpty()) return;
                JSObject o = new JSObject();
                o.put("name", name);
                try { o.put("address", d.getAddress()); } catch (SecurityException ignored) { }
                o.put("rssi", result.getRssi());
                android.util.Log.d("lidlprint", "BLE adv: " + name + " " + result.getRssi() + "dBm");
                found.put(o);
            }
        };
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        try {
            bleScanner.startScan(null, settings, bleScanCallback);
        } catch (SecurityException e) {
            call.reject("startScan: " + e.getMessage());
            return;
        }
        getBridge().getWebView().postDelayed(() -> {
            try {
                if (bleScanner != null && bleScanCallback != null) bleScanner.stopScan(bleScanCallback);
            } catch (Exception ignored) { }
            JSObject ret = new JSObject();
            ret.put("devices", found);
            call.resolve(ret);
        }, scanMs);
    }

    /** GATT connect + discover; services land in bleServices(). */
    @PluginMethod
    public void bleConnect(PluginCall call) {
        String address = call.getString("address");
        if (address == null || address.isEmpty()) {
            call.reject("address required");
            return;
        }
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothDevice device = bm.getAdapter().getRemoteDevice(address);
        bleServices.clear();
        bleNotifyHex.clear();
        // TRANSPORT_LE: pure GATT connection, no classic/bonding detours —
        // this is what lets us print without any pairing
        bleGatt = device.connectGatt(getContext(), false, new BluetoothGattCallback() {
            @Override
            public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
                android.util.Log.d("lidlprint", "BLE state " + newState + " (status " + status + ")");
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    try { g.discoverServices(); } catch (SecurityException ignored) { }
                }
            }

            @Override
            public void onServicesDiscovered(BluetoothGatt g, int status) {
                android.util.Log.d("lidlprint", "BLE services discovered, status " + status);
                try {
                    for (BluetoothGattService svc : g.getServices()) {
                        JSObject s = new JSObject();
                        s.put("uuid", svc.getUuid().toString());
                        JSArray chars = new JSArray();
                        for (BluetoothGattCharacteristic c : svc.getCharacteristics()) {
                            JSObject co = new JSObject();
                            co.put("uuid", c.getUuid().toString());
                            int props = c.getProperties();
                            java.util.List<String> p = new java.util.ArrayList<>();
                            if ((props & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0)
                                p.add("write");
                            if ((props & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0)
                                p.add("writeNR");
                            if ((props & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0)
                                p.add("notify");
                            if ((props & BluetoothGattCharacteristic.PROPERTY_READ) != 0)
                                p.add("read");
                            co.put("props", String.join(",", p));
                            chars.put(co);
                        }
                        s.put("characteristics", chars);
                        bleServices.add(s);
                    }
                } catch (SecurityException ignored) { }
            }

            @Override
            public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
                android.util.Log.d("lidlprint", "BLE write -> " + c.getUuid() + " status " + status);
                synchronized (writeLock) {
                    writePending = false;
                    writeStatus = status;
                    writeLock.notifyAll();
                }
            }

            @Override
            public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
                String hex = bytesToHex(value);
                android.util.Log.d("lidlprint", "BLE notify " + c.getUuid() + ": " + hex);
                bleNotifyHex.add(hex);
            }
        }, android.bluetooth.BluetoothDevice.TRANSPORT_LE);
        if (bleGatt == null) {
            call.reject("connectGatt failed");
            return;
        }
        call.resolve();
    }

    /** The discovered GATT table (call ~1s after bleConnect). */
    @PluginMethod
    public void bleServices(PluginCall call) {
        JSArray arr = new JSArray();
        for (JSObject s : bleServices) arr.put(s);
        JSObject ret = new JSObject();
        ret.put("services", arr);
        call.resolve(ret);
    }

    /** Enable notifications on a characteristic (writes the CCC descriptor). */
    @PluginMethod
    public void bleNotify(PluginCall call) {
        String uuid = call.getString("uuid");
        if (uuid == null || bleGatt == null) {
            call.reject("uuid + connect required");
            return;
        }
        BluetoothGattCharacteristic c = findChar(uuid);
        if (c == null) {
            call.reject("char not found");
            return;
        }
        try {
            bleGatt.setCharacteristicNotification(c, true);
            BluetoothGattDescriptor d = c.getDescriptor(
                    UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"));
            if (d != null) {
                d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                bleGatt.writeDescriptor(d);
            }
            call.resolve();
        } catch (SecurityException e) {
            call.reject(e.getMessage());
        }
    }

    /** Write hex to a characteristic — QUEUED: waits for onCharacteristicWrite
     *  before resolving, so consecutive JS writes are delivered in order
     *  without silent GATT queue overruns. */
    @PluginMethod
    public void bleWrite(PluginCall call) {
        String uuid = call.getString("uuid");
        String hex = call.getString("hex");
        if (uuid == null || hex == null || bleGatt == null) {
            call.reject("uuid + hex + connect required");
            return;
        }
        BluetoothGattCharacteristic c = findChar(uuid);
        if (c == null) {
            call.reject("char not found");
            return;
        }
        byte[] bytes = hexToBytes(hex);
        try {
            // wait for any in-flight write to complete before queueing this one
            synchronized (writeLock) {
                long deadline = System.currentTimeMillis() + 3000;
                while (writePending && System.currentTimeMillis() < deadline) {
                    try { writeLock.wait(200); } catch (InterruptedException ie) { break; }
                }
                writePending = true;
            }
            boolean ok;
            if (Build.VERSION.SDK_INT >= 33) {
                int type = (c.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0
                        ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                        : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
                int rv = bleGatt.writeCharacteristic(c, bytes, type);
                ok = rv == android.bluetooth.BluetoothStatusCodes.SUCCESS;
            } else {
                c.setValue(bytes);
                ok = bleGatt.writeCharacteristic(c);
            }
            JSObject ret = new JSObject();
            ret.put("ok", ok);
            call.resolve(ret);
        } catch (SecurityException e) {
            call.reject(e.getMessage());
        }
    }

    /** Drain queued notification packets (array of hex strings). */
    @PluginMethod
    public void bleReadNotify(PluginCall call) {
        JSArray arr = new JSArray();
        String h;
        while ((h = bleNotifyHex.poll()) != null) arr.put(h);
        JSObject ret = new JSObject();
        ret.put("notifications", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void bleDisconnect(PluginCall call) {
        if (bleGatt != null) {
            try { bleGatt.disconnect(); bleGatt.close(); } catch (Exception ignored) { }
            bleGatt = null;
        }
        call.resolve();
    }

    private BluetoothGattCharacteristic findChar(String uuid) {
        try {
            for (BluetoothGattService svc : bleGatt.getServices()) {
                BluetoothGattCharacteristic c = svc.getCharacteristic(UUID.fromString(uuid));
                if (c != null) return c;
            }
        } catch (SecurityException ignored) { }
        return null;
    }

    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static byte[] hexToBytes(String hex) {
        String clean = hex.replaceAll("[^0-9a-fA-F]", "");
        int len = clean.length() / 2;
        byte[] out = new byte[len];
        for (int i = 0; i < len; i++) {
            out[i] = (byte) Integer.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    // ---------------------------------------------------------------- classic SPP

    @PluginMethod
    public void listBonded(PluginCall call) {
        if (!hasConnectPermission()) {
            requestAllPermissions(call, "connectCallback");
            return;
        }
        doListBonded(call);
    }

    @PermissionCallback
    private void connectCallback(PluginCall call) {
        if (!hasConnectPermission()) {
            call.reject("BLUETOOTH_CONNECT permission denied by user");
        } else if ("listBonded".equals(call.getMethodName())) {
            doListBonded(call);
        } else {
            // connect(): resolve; JS proceeds with the real connect
            call.resolve();
        }
    }

    private void doListBonded(PluginCall call) {
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) {
            call.reject("no bluetooth adapter");
            return;
        }
        Set<BluetoothDevice> bonded = adapter.getBondedDevices();
        android.util.Log.d("lidlprint", "bonded=" + bonded.size() + " state=" + adapter.getState());
        JSArray arr = new JSArray();
        for (BluetoothDevice d : bonded) {
            JSObject o = new JSObject();
            o.put("name", d.getName() != null ? d.getName() : d.getAddress());
            o.put("address", d.getAddress());
            arr.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("devices", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String address = call.getString("address");
        if (address == null || address.isEmpty()) {
            call.reject("address required");
            return;
        }
        if (!hasConnectPermission()) {
            requestAllPermissions(call, "connectCallback");
            return;
        }
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        BluetoothDevice device = adapter.getRemoteDevice(address);
        new Thread(() -> {
            try {
                synchronized (ioLock) {
                    try {
                        socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
                        try {
                            adapter.cancelDiscovery(); // needs BLUETOOTH_SCAN; harmless if absent
                        } catch (SecurityException ignored) { }
                        socket.connect();
                    } catch (IOException secureFailed) {
                        closeLocked();
                        // many thermal printers only accept insecure RFCOMM (works with
                        // the OS-held bond key)
                        socket = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
                        socket.connect();
                    }
                    out = socket.getOutputStream();
                    in = socket.getInputStream();
                }
                call.resolve();
            } catch (IOException e) {
                closeLocked();
                call.reject("connect failed: " + e.getMessage());
            }
        }, "lidlprint-connect").start();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        closeLocked();
        call.resolve();
    }

    @PluginMethod
    public void write(PluginCall call) {
        String b64 = call.getString("data");
        if (b64 == null) {
            call.reject("data required");
            return;
        }
        byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
        try {
            synchronized (ioLock) {
                if (out == null) {
                    call.reject("not connected");
                    return;
                }
                out.write(bytes);
                out.flush();
            }
            call.resolve();
        } catch (IOException e) {
            call.reject("write failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void read(PluginCall call) {
        int timeoutMs = call.getInt("timeoutMs", 1000);
        try {
            synchronized (ioLock) {
                if (in == null) {
                    call.reject("not connected");
                    return;
                }
                // available() poll loop until timeout — bridges are request/response,
                // a blocking read would hold the Capacitor thread pool.
                java.io.ByteArrayOutputStream acc = new java.io.ByteArrayOutputStream();
                long deadline = System.currentTimeMillis() + timeoutMs;
                while (System.currentTimeMillis() < deadline) {
                    int n = in.available();
                    if (n > 0) {
                        byte[] buf = new byte[n];
                        int got = in.read(buf);
                        if (got > 0) acc.write(buf, 0, got);
                        // brief linger for coalesced ACKs
                        try { Thread.sleep(10); } catch (InterruptedException ignored) { }
                        continue;
                    }
                    if (acc.size() > 0) break; // got something, good enough
                    try { Thread.sleep(20); } catch (InterruptedException ignored) { }
                }
                JSObject ret = new JSObject();
                ret.put("data", Base64.encodeToString(acc.toByteArray(), Base64.NO_WRAP));
                call.resolve(ret);
            }
        } catch (IOException e) {
            call.reject("read failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void openPairingSettings(PluginCall call) {
        android.util.Log.d("lidlprint", "openPairingSettings called");
        getActivity().runOnUiThread(() -> {
            try {
                android.content.Intent intent = new android.content.Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS);
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                android.util.Log.d("lidlprint", "settings activity launched");
                call.resolve();
            } catch (Exception e) {
                android.util.Log.d("lidlprint", "startActivity failed: " + e);
                call.reject("startActivity failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void readContentUri(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url required");
            return;
        }
        try {
            android.net.Uri uri = android.net.Uri.parse(url);
            java.io.InputStream in = getContext().getContentResolver().openInputStream(uri);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("read failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void readClipboardImage(PluginCall call) {
        android.content.ClipboardManager cm = (android.content.ClipboardManager)
                getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE);
        if (cm == null || !cm.hasPrimaryClip()) {
            call.reject("clipboard empty");
            return;
        }
        android.content.ClipDescription desc = cm.getPrimaryClipDescription();
        if (desc == null) {
            call.reject("no clip description");
            return;
        }
        boolean hasImage = false;
        for (int i = 0; i < desc.getMimeTypeCount(); i++) {
            if (desc.getMimeType(i).startsWith("image/")) { hasImage = true; break; }
        }
        if (!hasImage) {
            call.reject("clipboard has no image (" + desc.toString() + ")");
            return;
        }
        android.content.ClipData clip = cm.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) {
            call.reject("empty clip");
            return;
        }
        android.net.Uri uri = clip.getItemAt(0).getUri();
        if (uri == null) {
            call.reject("clip item has no uri");
            return;
        }
        try (java.io.InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("read failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void isConnected(PluginCall call) {
        JSObject ret = new JSObject();
        synchronized (ioLock) {
            ret.put("connected", socket != null && socket.isConnected());
        }
        call.resolve(ret);
    }

    private boolean hasConnectPermission() {
        if (Build.VERSION.SDK_INT < 31) return true;
        return ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void closeLocked() {
        synchronized (ioLock) {
            try { if (in != null) in.close(); } catch (IOException ignored) { }
            try { if (out != null) out.close(); } catch (IOException ignored) { }
            try { if (socket != null) socket.close(); } catch (IOException ignored) { }
            in = null;
            out = null;
            socket = null;
        }
    }
}
