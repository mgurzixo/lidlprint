package org.capacitor.quasar.lidlprint;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BluetoothClassicPlugin.class);
        super.onCreate(savedInstanceState);
        android.webkit.WebView.setWebContentsDebuggingEnabled(true);
    }

}
