package com.datafordidi.mobilecollector;

final class CaptureNotificationState {
    private CaptureNotificationState() {
    }

    static String text(
            String ocrStatus,
            String uploadStatus,
            int frameReceived,
            int ocrAttempt,
            int parsed,
            int recognized,
            int pending,
            int failed,
            String skipReason
    ) {
        String ocr = compact(ocrStatus, "采集中");
        String upload = compact(uploadStatus, "就绪");
        String skip = compact(skipReason, "");
        String output = "OCR" + ocr
                + " F" + positive(frameReceived)
                + "/O" + positive(ocrAttempt)
                + "/P" + positive(parsed)
                + "/R" + positive(recognized)
                + " · 回传" + upload
                + " Q" + positive(pending)
                + "/E" + positive(failed);
        return skip.isEmpty() ? output : output + " · 跳过:" + skip;
    }

    private static int positive(int value) {
        return Math.max(0, value);
    }

    private static String compact(String value, String fallback) {
        String output = value == null ? "" : value.replaceAll("[\\r\\n]+", " ").trim();
        return output.isEmpty() ? fallback : output;
    }
}
