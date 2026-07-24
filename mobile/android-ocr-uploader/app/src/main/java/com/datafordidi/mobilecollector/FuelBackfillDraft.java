package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class FuelBackfillDraft {
    final List<GradeDraft> grades = new ArrayList<>();

    static FuelBackfillDraft fromRow(JSONObject row) {
        FuelBackfillDraft draft = new FuelBackfillDraft();
        JSONObject fuel = row == null ? null : row.optJSONObject("fuelObservation");
        JSONArray offers = fuel == null ? null : fuel.optJSONArray("fuelOffers");
        if (offers == null) return draft;
        for (int index = 0; index < offers.length(); index++) {
            JSONObject offer = offers.optJSONObject(index);
            if (offer == null) continue;
            GradeDraft grade = new GradeDraft();
            grade.gradeCode = offer.optString("gradeCode");
            grade.gradeLabel = offer.optString("gradeLabel");
            grade.listPrice = decimal(offer.opt("listPrice"));
            grade.discountPrice = decimal(offer.opt("discountPrice"));
            grade.unclassifiedPrice = decimal(offer.opt("unclassifiedPrice"));
            draft.grades.add(grade);
        }
        return draft;
    }

    static FuelBackfillDraft fromJson(JSONObject value) {
        FuelBackfillDraft draft = new FuelBackfillDraft();
        JSONArray items = value == null ? null : value.optJSONArray("grades");
        if (items == null) return draft;
        for (int index = 0; index < items.length(); index++) {
            JSONObject item = items.optJSONObject(index);
            if (item == null) continue;
            GradeDraft grade = new GradeDraft();
            grade.gradeCode = item.optString("gradeCode");
            grade.gradeLabel = item.optString("gradeLabel");
            grade.listPrice = item.optString("listPrice");
            grade.discountPrice = item.optString("discountPrice");
            grade.unclassifiedPrice = item.optString("unclassifiedPrice");
            draft.grades.add(grade);
        }
        return draft;
    }

    JSONObject toJson() {
        JSONArray items = new JSONArray();
        for (GradeDraft grade : grades) {
            JSONObject item = new JSONObject();
            put(item, "gradeCode", clean(grade.gradeCode));
            put(item, "gradeLabel", clean(grade.gradeLabel));
            put(item, "listPrice", clean(grade.listPrice));
            put(item, "discountPrice", clean(grade.discountPrice));
            put(item, "unclassifiedPrice", clean(grade.unclassifiedPrice));
            items.put(item);
        }
        JSONObject value = new JSONObject();
        put(value, "grades", items);
        return value;
    }

    void addGrade(String gradeLabel) {
        GradeDraft grade = new GradeDraft();
        grade.gradeLabel = clean(gradeLabel);
        grade.gradeCode = grade.gradeLabel.replace("#", "").replace("＃", "");
        grades.add(grade);
    }

    void removeGrade(int index) {
        if (index >= 0 && index < grades.size()) grades.remove(index);
    }

    Validation validate(String capturedAt) {
        Map<String, String> errors = new LinkedHashMap<>();
        JSONArray offers = new JSONArray();
        for (int index = 0; index < grades.size(); index++) {
            GradeDraft grade = grades.get(index);
            String prefix = "grades[" + index + "]";
            String label = clean(grade.gradeLabel);
            String code = clean(grade.gradeCode);
            if (label.isEmpty() || code.isEmpty()) {
                errors.put(prefix + ".grade", "请选择油号");
                continue;
            }
            Double list = price(grade.listPrice, prefix + ".listPrice", errors);
            Double discount = price(grade.discountPrice, prefix + ".discountPrice", errors);
            Double other = price(grade.unclassifiedPrice, prefix + ".unclassifiedPrice", errors);
            if (list == null && discount == null && other == null) {
                errors.put(prefix + ".price", "请填写至少一个油价");
                continue;
            }
            if (list != null && discount != null && discount > list) {
                errors.put(prefix + ".discountPrice", "优惠价不能高于挂牌价");
                continue;
            }
            FuelOffer offer = new FuelOffer();
            offer.gradeCode = code;
            offer.gradeLabel = label;
            offer.fuelType = "0".equals(code) ? "diesel" : "gasoline";
            offer.listPrice = list;
            offer.discountPrice = discount;
            offer.unclassifiedPrice = other;
            offer.discountKind = discount == null ? "none" : "manual";
            offer.capturedAt = capturedAt;
            if (offer.valid()) offers.put(offer.toJson());
        }
        if (grades.isEmpty()) errors.put("form", "请添加至少一个油号");
        return errors.isEmpty() ? Validation.success(offers) : Validation.failure(errors);
    }

    private static Double price(String value, String field, Map<String, String> errors) {
        String text = clean(value);
        if (text.isEmpty()) return null;
        if (!text.matches("\\d{1,2}(?:\\.\\d{1,4})?")) {
            errors.put(field, "请输入最多四位小数的油价");
            return null;
        }
        try {
            BigDecimal parsed = new BigDecimal(text);
            if (parsed.compareTo(BigDecimal.ZERO) <= 0 || parsed.compareTo(BigDecimal.valueOf(30)) > 0) {
                errors.put(field, "油价需大于 0 且不超过 30");
                return null;
            }
            return parsed.doubleValue();
        } catch (NumberFormatException error) {
            errors.put(field, "请输入有效油价");
            return null;
        }
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static String decimal(Object value) {
        if (!(value instanceof Number) || ((Number) value).doubleValue() <= 0d) return "";
        return BigDecimal.valueOf(((Number) value).doubleValue()).stripTrailingZeros().toPlainString();
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化油价回填草稿", error);
        }
    }

    static final class GradeDraft {
        String gradeCode = "";
        String gradeLabel = "";
        String listPrice = "";
        String discountPrice = "";
        String unclassifiedPrice = "";
    }

    static final class Validation {
        final JSONArray offers;
        final Map<String, String> errors;

        private Validation(JSONArray offers, Map<String, String> errors) {
            this.offers = offers;
            this.errors = errors;
        }

        static Validation success(JSONArray offers) {
            return new Validation(offers, new LinkedHashMap<>());
        }

        static Validation failure(Map<String, String> errors) {
            return new Validation(new JSONArray(), new LinkedHashMap<>(errors));
        }

        boolean valid() {
            return errors.isEmpty();
        }
    }
}
