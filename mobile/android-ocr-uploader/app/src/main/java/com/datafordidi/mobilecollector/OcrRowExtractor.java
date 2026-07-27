package com.datafordidi.mobilecollector;

import android.graphics.Bitmap;
import android.graphics.ImageFormat;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.media.Image;
import android.media.ImageReader;
import android.util.Log;
import android.view.Surface;

import com.google.mlkit.vision.text.Text;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * OCR 原始识别结果转换工具。
 */
final class OcrRowExtractor {

    private OcrRowExtractor() {
    }

    static List<OcrRow> fromText(Text text, int width, int height) {
        List<OcrRow> output = new ArrayList<>();
        if (text == null) return output;
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                Rect box = line.getBoundingBox();
                if (box == null) continue;
                output.add(new OcrRow(
                        line.getText(),
                        1f,
                        box.left / (float) width,
                        box.top / (float) height,
                        Math.max(0, box.width()) / (float) width,
                        Math.max(0, box.height()) / (float) height
                ));
            }
        }
        output.sort(Comparator.comparingDouble((OcrRow row) -> row.y).thenComparingDouble(row -> row.x));
        return output;
    }

    static Bitmap bitmapFromImage(Image image) {
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer buffer = plane.getBuffer();
        int pixelStride = plane.getPixelStride();
        int rowStride = plane.getRowStride();
        int rowPadding = rowStride - pixelStride * image.getWidth();
        int paddedWidth = image.getWidth() + rowPadding / pixelStride;
        Bitmap padded = Bitmap.createBitmap(paddedWidth, image.getHeight(), Bitmap.Config.ARGB_8888);
        padded.copyPixelsFromBuffer(buffer);
        if (paddedWidth == image.getWidth()) return padded;
        Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, image.getWidth(), image.getHeight());
        padded.recycle();
        return cropped;
    }
}
