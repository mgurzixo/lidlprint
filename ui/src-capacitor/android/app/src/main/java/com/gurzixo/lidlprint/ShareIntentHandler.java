package com.gurzixo.lidlprint;

import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Bridge;

/**
 * Extracts ACTION_SEND payloads and forwards them to the WebView as
 * window.__onLidlPrintShare({uri|text}). Pure plumbing (SPEC §4.1).
 */
public final class ShareIntentHandler {

    private static final Bridge[] bridgeHolder = new Bridge[1];
    private static JSObject pending; // share received before the WebView was ready

    private ShareIntentHandler() { }

    /** MainActivity passes its bridge once created. */
    public static void attach(Bridge bridge) {
        bridgeHolder[0] = bridge;
        if (pending != null && bridge != null) {
            JSObject data = pending;
            pending = null;
            dispatch(bridge, data);
        }
    }

    public static void handle(MainActivity activity, Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType() == null ? "" : intent.getType();
        JSObject data = new JSObject();

        if (type.startsWith("text/")) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null && !text.isEmpty()) data.put("text", text);
        } else if (type.startsWith("image/")) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) {
                // copy into app cache so the WebView can load it without
                // juggling per-target content-provider permissions
                Uri local = copyToCache(activity, uri);
                if (local != null) data.put("uri", local.toString());
            }
        }

        if (!data.has("text") && !data.has("uri")) return;

        Bridge bridge = bridgeHolder[0];
        if (bridge == null) {
            pending = data; // WebView not up yet
        } else {
            dispatch(bridge, data);
        }
    }

    private static void dispatch(Bridge bridge, JSObject data) {
        bridge.getWebView().post(() -> {
            String json = data.toString();
            String script = "window.__onLidlPrintShare && window.__onLidlPrintShare(" + json + ");";
            bridge.getWebView().evaluateJavascript(script, null);
        });
    }

    private static Uri copyToCache(MainActivity activity, Uri src) {
        try {
            ContentResolver cr = activity.getContentResolver();
            String name = "share-" + System.currentTimeMillis() +
                    (src.getPath() != null && src.getPath().contains(".png") ? ".png" : ".img");
            java.io.File out = new java.io.File(activity.getCacheDir(), name);
            try (java.io.InputStream in = cr.openInputStream(src);
                 java.io.FileOutputStream fos = new java.io.FileOutputStream(out)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
            }
            return Uri.fromFile(out);
        } catch (Exception e) {
            return null;
        }
    }
}
