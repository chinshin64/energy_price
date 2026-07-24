package com.datafordidi.mobilecollector;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

public class AutomationCommandReceiver extends BroadcastReceiver {
    public static final String ACTION_TAP = "com.datafordidi.mobilecollector.AUTOMATION_TAP";
    public static final String ACTION_BACK = "com.datafordidi.mobilecollector.AUTOMATION_BACK";
    public static final String ACTION_SCROLL = "com.datafordidi.mobilecollector.AUTOMATION_SCROLL";
    public static final String ACTION_SET_TEXT = "com.datafordidi.mobilecollector.AUTOMATION_SET_TEXT";
    public static final String ACTION_PASTE_TEXT = "com.datafordidi.mobilecollector.AUTOMATION_PASTE_TEXT";
    public static final String ACTION_CLICK_TEXT = "com.datafordidi.mobilecollector.AUTOMATION_CLICK_TEXT";
    public static final String ACTION_SAVE_SETTINGS = "com.datafordidi.mobilecollector.AUTOMATION_SAVE_SETTINGS";
    public static final String ACTION_IME_REPLACE_TEXT = "com.datafordidi.mobilecollector.AUTOMATION_IME_REPLACE_TEXT";
    public static final String ACTION_START_NETWORK_COMMAND = "com.datafordidi.mobilecollector.AUTOMATION_START_NETWORK_COMMAND";
    public static final String ACTION_STOP_NETWORK_COMMAND = "com.datafordidi.mobilecollector.AUTOMATION_STOP_NETWORK_COMMAND";

    private static final String TAG = "DataForDidiAutomation";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }

        String action = intent.getAction();
        boolean ok;
        try {
            ok = execute(context, intent, action);
        } catch (RuntimeException error) {
            Log.w(TAG, action + " rejected: " + error.getMessage());
            ok = false;
        }

        Log.i(TAG, action + " ok=" + ok);
        setResultCode(ok ? 0 : 1);
    }

    private boolean execute(Context context, Intent intent, String action) {
        if (ACTION_TAP.equals(action)) {
            return AutoScrollAccessibilityService.requestTap(
                    intent.getFloatExtra("x", 0.5f),
                    intent.getFloatExtra("y", 0.5f)
            );
        }
        if (ACTION_BACK.equals(action)) {
            return AutoScrollAccessibilityService.requestBack();
        }
        if (ACTION_SCROLL.equals(action)) {
            return AutoScrollAccessibilityService.requestScrollForward();
        }
        if (ACTION_SET_TEXT.equals(action)) {
            return AutoScrollAccessibilityService.requestSetFocusedText(boundedText(intent.getStringExtra("text")));
        }
        if (ACTION_PASTE_TEXT.equals(action)) {
            String text = boundedText(intent.getStringExtra("text"));
            return AdbTextInputService.pasteText(text)
                    || AutoScrollAccessibilityService.requestPasteFocusedText(text);
        }
        if (ACTION_CLICK_TEXT.equals(action)) {
            return AutoScrollAccessibilityService.requestClickText(
                    boundedText(intent.getStringExtra("text")),
                    intent.getBooleanExtra("contains", true)
            );
        }
        if (ACTION_SAVE_SETTINGS.equals(action)) {
            CollectorSettings.save(
                    context,
                    valueOrCurrent(intent.getStringExtra("serverUrl"), CollectorSettings.getServerUrl(context)),
                    valueOrCurrent(intent.getStringExtra("token"), CollectorSettings.getToken(context)),
                    valueOrCurrent(intent.getStringExtra("platform"), CollectorSettings.getPlatform(context)),
                    valueOrCurrent(intent.getStringExtra("city"), CollectorSettings.getCity(context)),
                    intent.getIntExtra("minIntervalMillis", CollectorSettings.getMinIntervalMillis(context)),
                    intent.getIntExtra("maxIntervalMillis", CollectorSettings.getMaxIntervalMillis(context)),
                    intent.getIntExtra("maxPages", CollectorSettings.getMaxPages(context)),
                    intent.getBooleanExtra("detailEnrichmentEnabled", CollectorSettings.isDetailEnrichmentEnabled(context)),
                    intent.getBooleanExtra("aiSupervisorEnabled", CollectorSettings.isAiSupervisorEnabled(context)),
                    intent.getBooleanExtra("testEvidenceEnabled", CollectorSettings.isTestEvidenceEnabled(context)),
                    intent.getBooleanExtra("rawOcrUploadEnabled", CollectorSettings.isRawOcrUploadEnabled(context))
            );
            return true;
        }
        if (ACTION_IME_REPLACE_TEXT.equals(action)) {
            return AdbTextInputService.replaceText(boundedText(intent.getStringExtra("text")));
        }
        if (ACTION_START_NETWORK_COMMAND.equals(action)) {
            Intent service = new Intent(context, NetworkCommandService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
            return true;
        }
        if (ACTION_STOP_NETWORK_COMMAND.equals(action)) {
            context.stopService(new Intent(context, NetworkCommandService.class));
            return true;
        }
        if (CollectorControlActions.ACTION_STOP.equals(action)) {
            context.stopService(new Intent(context, CaptureOcrService.class));
            context.stopService(new Intent(context, AccessibilityTextCollectService.class));
            LocationMockHelper.getInstance().stopMockLocation();
            return true;
        }
        return false;
    }

    private String valueOrCurrent(String incoming, String current) {
        if (incoming == null) {
            return current;
        }
        return incoming;
    }

    private String boundedText(String value) {
        String normalized = value == null ? "" : value;
        if (normalized.length() > 500) {
            throw new IllegalArgumentException("automation text exceeds 500 characters");
        }
        return normalized;
    }
}
