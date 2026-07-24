package com.datafordidi.mobilecollector;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.inputmethodservice.InputMethodService;
import android.view.inputmethod.InputConnection;

import java.lang.ref.WeakReference;

public class AdbTextInputService extends InputMethodService {
    private static WeakReference<AdbTextInputService> currentService = new WeakReference<>(null);
    private static String pendingText = null;

    public static boolean replaceText(String text) {
        AdbTextInputService service = currentService.get();
        if (service == null) {
            pendingText = text;
            return false;
        }
        return service.replaceCurrentText(text);
    }

    public static boolean pasteText(String text) {
        AdbTextInputService service = currentService.get();
        if (service == null) {
            pendingText = text;
            return false;
        }
        return service.pasteCurrentText(text);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        currentService = new WeakReference<>(this);
    }

    @Override
    public void onStartInputView(android.view.inputmethod.EditorInfo info, boolean restarting) {
        super.onStartInputView(info, restarting);
        if (pendingText != null) {
            String text = pendingText;
            pendingText = null;
            replaceCurrentText(text);
        }
    }

    @Override
    public void onDestroy() {
        currentService.clear();
        super.onDestroy();
    }

    private boolean replaceCurrentText(String text) {
        InputConnection connection = getCurrentInputConnection();
        if (connection == null) {
            pendingText = text;
            return false;
        }
        connection.beginBatchEdit();
        try {
            connection.performContextMenuAction(android.R.id.selectAll);
            connection.commitText(text == null ? "" : text, 1);
            return true;
        } finally {
            connection.endBatchEdit();
        }
    }

    private boolean pasteCurrentText(String text) {
        InputConnection connection = getCurrentInputConnection();
        if (connection == null) {
            pendingText = text;
            return false;
        }
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) {
            return false;
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("data_for_didi", text == null ? "" : text));
        connection.beginBatchEdit();
        try {
            connection.performContextMenuAction(android.R.id.selectAll);
            return connection.performContextMenuAction(android.R.id.paste);
        } finally {
            connection.endBatchEdit();
        }
    }
}
