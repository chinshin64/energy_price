package com.datafordidi.mobilecollector;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Bitmap;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import android.view.Display;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public class ScreenshotHelper {
    private static final String TAG = "DataForDidiScreenshot";

    /**
     * 使用 AccessibilityService.takeScreenshot 截取屏幕，
     * 返回 Base64 编码的 JPEG。
     * 需要 Android 11+ (API 30+)
     */
    public static String captureAsBase64(AccessibilityService service, int quality) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            Log.w(TAG, "takeScreenshot requires API 30+");
            return null;
        }
        if (service == null) {
            return null;
        }

        try {
            CountDownLatch latch = new CountDownLatch(1);
            AtomicReference<Bitmap> result = new AtomicReference<>();
            AtomicReference<String> error = new AtomicReference<>();

            // API 35+ 需要 displayId 参数
            int displayId = Display.DEFAULT_DISPLAY;
            service.takeScreenshot(
                    displayId,
                    service.getMainExecutor(),
                    new AccessibilityService.TakeScreenshotCallback() {
                        @Override
                        public void onSuccess(AccessibilityService.ScreenshotResult screenshotResult) {
                            try {
                                Bitmap bitmap = Bitmap.wrapHardwareBuffer(
                                        screenshotResult.getHardwareBuffer(),
                                        screenshotResult.getColorSpace()
                                );
                                if (bitmap != null) {
                                    Bitmap copy = bitmap.copy(Bitmap.Config.ARGB_8888, false);
                                    bitmap.recycle();
                                    result.set(copy);
                                }
                                screenshotResult.getHardwareBuffer().close();
                            } catch (Exception e) {
                                error.set("onSuccess processing: " + e.getMessage());
                            }
                            latch.countDown();
                        }

                        @Override
                        public void onFailure(int errorCode) {
                            error.set("takeScreenshot failed code=" + errorCode);
                            latch.countDown();
                        }
                    }
            );

            if (!latch.await(5, TimeUnit.SECONDS)) {
                Log.w(TAG, "takeScreenshot timed out");
                return null;
            }

            if (error.get() != null) {
                Log.w(TAG, error.get());
                return null;
            }

            Bitmap bitmap = result.get();
            if (bitmap == null) {
                return null;
            }

            // 压缩到 JPEG 降低体积
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, Math.max(30, Math.min(95, quality)), bos);
            bitmap.recycle();

            byte[] bytes = bos.toByteArray();
            Log.i(TAG, "screenshot captured: " + bytes.length + " bytes, " + bitmap.getWidth() + "x" + bitmap.getHeight());
            return Base64.encodeToString(bytes, Base64.NO_WRAP);
        } catch (Exception e) {
            Log.w(TAG, "takeScreenshot exception: " + e.getMessage());
            return null;
        }
    }
}
