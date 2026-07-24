package com.datafordidi.mobilecollector;

import org.json.JSONException;
import org.json.JSONObject;

public class OcrRow {
    public final String text;
    public final float confidence;
    public final float x;
    public final float y;
    public final float width;
    public final float height;

    public OcrRow(String text, float confidence, float x, float y, float width, float height) {
        this.text = text == null ? "" : text.trim();
        this.confidence = confidence;
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject box = new JSONObject()
                .put("x", x)
                .put("y", y)
                .put("width", width)
                .put("height", height);

        return new JSONObject()
                .put("text", text)
                .put("confidence", confidence)
                .put("boundingBox", box);
    }
}
