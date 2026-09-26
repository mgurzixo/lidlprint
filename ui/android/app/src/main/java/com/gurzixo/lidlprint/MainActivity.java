package com.gurzixo.lidlprint;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BluetoothClassicPlugin.class);
        super.onCreate(savedInstanceState);
        ShareIntentHandler.attach(bridge);
        // cold-start share (activity launched fresh with the share intent)
        ShareIntentHandler.handle(this, getIntent());
    }

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        ShareIntentHandler.handle(this, intent);
    }

}
