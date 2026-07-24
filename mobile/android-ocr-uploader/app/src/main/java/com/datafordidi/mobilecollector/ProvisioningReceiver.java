package com.datafordidi.mobilecollector;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class ProvisioningReceiver extends BroadcastReceiver {
    static final String ACTION_PROVISION = "com.datafordidi.ocruploader.PROVISION";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_PROVISION.equals(intent.getAction())) return;
        AppSettings.provision(
                context,
                intent.getStringExtra("url") == null
                        ? AppSettings.getUploadUrl(context)
                        : intent.getStringExtra("url"),
                intent.getStringExtra("token")
        );
    }
}
