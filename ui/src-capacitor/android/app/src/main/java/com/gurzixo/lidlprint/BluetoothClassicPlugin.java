package com.gurzixo.lidlprint;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
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
@CapacitorPlugin(name = "BluetoothClassic")
public class BluetoothClassicPlugin extends Plugin {

    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private BluetoothSocket socket;
    private OutputStream out;
    private InputStream in;
    private final Object ioLock = new Object();

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
        } else if (call.getMethodName().equals("listBonded")) {
            doListBonded(call);
        } else {
            // connect(): just resolve; the JS layer retries the actual connect
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
