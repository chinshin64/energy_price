package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

final class FuelQuote {
    private static final BigDecimal CENT = new BigDecimal("0.01");
    private static final BigDecimal MAX_AMOUNT = new BigDecimal("100000.00");
    private static final Set<String> JSON_FIELDS = new HashSet<>(Arrays.asList(
            "quoteObservationId",
            "quoteDedupKey",
            "gradeCode",
            "gradeLabel",
            "gunCode",
            "gunLabel",
            "selectedAmount",
            "grossDiscount",
            "serviceFee",
            "netDiscount",
            "payableAmount",
            "quoteEntry",
            "needsReview",
            "capturedAt"
    ));

    String quoteObservationId;
    String quoteDedupKey;
    String gradeCode;
    String gradeLabel;
    String gunCode;
    String gunLabel;
    BigDecimal selectedAmount;
    BigDecimal grossDiscount;
    BigDecimal serviceFee;
    BigDecimal netDiscount;
    BigDecimal payableAmount;
    String quoteEntry = "inline";
    boolean needsReview;
    boolean gradeInferred;
    String capturedAt;

    boolean valid() {
        if (clean(gradeCode).isEmpty() || clean(gradeLabel).isEmpty()) return false;
        if (!positive(selectedAmount) || selectedAmount.compareTo(MAX_AMOUNT) > 0) return false;
        if (!optionalMoney(grossDiscount)
                || !optionalMoney(serviceFee)
                || !optionalMoney(netDiscount)
                || !optionalMoney(payableAmount)) {
            return false;
        }
        if (grossDiscount == null && serviceFee == null && payableAmount == null) return false;
        return "inline".equals(quoteEntry) || "explanation_popup".equals(quoteEntry);
    }

    void validateFormula() {
        needsReview = gradeInferred;
        netDiscount = null;

        // 若三个金额齐全但缺少 grossDiscount，用公式反推：200 = 实付 + 优惠 - 服务费。
        if (grossDiscount == null && selectedAmount != null && payableAmount != null && serviceFee != null) {
            BigDecimal inferred = money(selectedAmount.subtract(payableAmount).add(serviceFee));
            if (inferred.signum() >= 0) grossDiscount = inferred;
        }

        if (grossDiscount == null || serviceFee == null) {
            needsReview = true;
            return;
        }
        netDiscount = money(grossDiscount.subtract(serviceFee));
        if (netDiscount.signum() < 0) needsReview = true;
        if (payableAmount == null || selectedAmount == null) {
            needsReview = true;
            return;
        }
        BigDecimal expected = money(selectedAmount.subtract(grossDiscount).add(serviceFee));
        if (expected.subtract(payableAmount).abs().compareTo(CENT) > 0) needsReview = true;
    }

    void finalizeIdentity(
            String platform,
            String sourceStationKey,
            FuelOffer offer,
            String providerName
    ) {
        capturedAt = CaptureTime.requireUtc(capturedAt);
        String seed = identitySeed(
                platform,
                sourceStationKey,
                gradeCode,
                gunCode,
                selectedAmount,
                capturedAt,
                offer == null ? null : offer.displayPrice,
                offer == null ? null : offer.stationPrice,
                offer == null ? null : offer.nationalPrice,
                grossDiscount,
                serviceFee,
                payableAmount,
                providerName
        );
        quoteDedupKey = DeviceIdentity.sha256(seed);
        quoteObservationId = DeviceIdentity.sha256("fuel-quote-observation|" + seed);
    }

    static boolean repairJsonIdentity(
            String platform,
            String sourceStationKey,
            JSONObject offer,
            JSONObject quote,
            String providerName
    ) {
        if (quote == null) return false;
        String capturedAt = CaptureTime.requireUtc(quote.optString("capturedAt"));
        String seed = identitySeed(
                platform,
                sourceStationKey,
                quote.optString("gradeCode"),
                nullable(quote, "gunCode"),
                decimal(quote, "selectedAmount"),
                capturedAt,
                priceDecimal(offer, "displayPrice"),
                priceDecimal(offer, "stationPrice"),
                priceDecimal(offer, "nationalPrice"),
                decimal(quote, "grossDiscount"),
                decimal(quote, "serviceFee"),
                decimal(quote, "payableAmount"),
                providerName
        );
        String dedupKey = DeviceIdentity.sha256(seed);
        String observationId = DeviceIdentity.sha256("fuel-quote-observation|" + seed);
        boolean changed = !dedupKey.equals(quote.optString("quoteDedupKey"))
                || !observationId.equals(quote.optString("quoteObservationId"))
                || !capturedAt.equals(quote.optString("capturedAt"));
        if (changed) {
            put(quote, "quoteDedupKey", dedupKey);
            put(quote, "quoteObservationId", observationId);
            put(quote, "capturedAt", capturedAt);
        }
        return changed;
    }

    String businessDedupKey() {
        return DeviceIdentity.sha256(
                clean(gradeCode) + "|" + clean(gunCode) + "|" + minor(selectedAmount)
                        + "|" + minor(grossDiscount) + "|" + minor(serviceFee)
                        + "|" + minor(payableAmount)
        );
    }

    JSONObject toJson() {
        validateFormula();
        if (!valid()) throw new IllegalArgumentException("燃油报价记录不完整");
        if (clean(quoteObservationId).isEmpty() || clean(quoteDedupKey).isEmpty()) {
            throw new IllegalArgumentException("燃油报价缺少稳定标识");
        }
        JSONObject value = new JSONObject();
        put(value, "quoteObservationId", quoteObservationId);
        put(value, "quoteDedupKey", quoteDedupKey);
        put(value, "gradeCode", clean(gradeCode));
        put(value, "gradeLabel", clean(gradeLabel));
        putNullable(value, "gunCode", gunCode);
        putNullable(value, "gunLabel", gunLabel);
        putMoney(value, "selectedAmount", selectedAmount);
        putMoney(value, "grossDiscount", grossDiscount);
        putMoney(value, "serviceFee", serviceFee);
        putMoney(value, "netDiscount", netDiscount);
        putMoney(value, "payableAmount", payableAmount);
        put(value, "quoteEntry", quoteEntry);
        put(value, "needsReview", needsReview);
        put(value, "capturedAt", CaptureTime.requireUtc(capturedAt));
        return value;
    }

    static void requireValidJson(JSONObject value) {
        if (value == null) throw new IllegalArgumentException("燃油报价为空");
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) {
            if (!JSON_FIELDS.contains(keys.next())) {
                throw new IllegalArgumentException("燃油报价包含未知字段");
            }
        }
        FuelQuote quote = new FuelQuote();
        quote.quoteObservationId = value.optString("quoteObservationId");
        quote.quoteDedupKey = value.optString("quoteDedupKey");
        quote.gradeCode = value.optString("gradeCode");
        quote.gradeLabel = value.optString("gradeLabel");
        quote.gunCode = nullable(value, "gunCode");
        quote.gunLabel = nullable(value, "gunLabel");
        quote.selectedAmount = decimal(value, "selectedAmount");
        quote.grossDiscount = decimal(value, "grossDiscount");
        quote.serviceFee = decimal(value, "serviceFee");
        quote.netDiscount = decimal(value, "netDiscount");
        quote.payableAmount = decimal(value, "payableAmount");
        quote.quoteEntry = value.optString("quoteEntry");
        boolean observedNeedsReview = value.optBoolean("needsReview");
        quote.needsReview = observedNeedsReview;
        quote.capturedAt = value.optString("capturedAt");
        if (!quote.valid()
                || clean(quote.quoteObservationId).isEmpty()
                || clean(quote.quoteDedupKey).isEmpty()) {
            throw new IllegalArgumentException("燃油报价字段无效");
        }
        BigDecimal observedNet = quote.netDiscount;
        quote.validateFormula();
        if (observedNeedsReview != quote.needsReview) {
            throw new IllegalArgumentException("燃油报价复核状态不一致");
        }
        if (observedNet != null && quote.netDiscount != null
                && observedNet.subtract(quote.netDiscount).abs().compareTo(CENT) > 0) {
            throw new IllegalArgumentException("燃油报价净优惠不一致");
        }
    }

    static BigDecimal money(String value) {
        String text = clean(value).replace("￥", "").replace("¥", "").replace(",", ".");
        if (text.isEmpty()) return null;
        try {
            BigDecimal decimal = new BigDecimal(text);
            if (decimal.scale() > 2) return null;
            return money(decimal);
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static BigDecimal decimal(JSONObject value, String key) {
        if (value == null || value.isNull(key)) return null;
        return money(value.optString(key));
    }

    private static BigDecimal priceDecimal(JSONObject value, String key) {
        if (value == null || value.isNull(key)) return null;
        String text = value.optString(key, "").trim();
        if (text.isEmpty()) return null;
        try {
            BigDecimal price = new BigDecimal(text);
            return price.signum() > 0 && price.scale() <= 4 ? price : null;
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static String nullable(JSONObject value, String key) {
        return value == null || value.isNull(key) ? null : clean(value.optString(key));
    }

    private static BigDecimal money(BigDecimal value) {
        return value == null ? null : value.setScale(2, RoundingMode.HALF_UP);
    }

    private static boolean positive(BigDecimal value) {
        return value != null && value.signum() > 0 && value.scale() <= 2;
    }

    private static boolean optionalMoney(BigDecimal value) {
        return value == null
                || (value.signum() >= 0 && value.compareTo(MAX_AMOUNT) <= 0 && value.scale() <= 2);
    }

    private static String minor(BigDecimal value) {
        return value == null
                ? ""
                : money(value).movePointRight(2).setScale(0, RoundingMode.UNNECESSARY).toPlainString();
    }

    private static String normalized(BigDecimal value, int scale) {
        return value == null
                ? ""
                : value.setScale(scale, RoundingMode.UNNECESSARY).toPlainString();
    }

    private static String identitySeed(
            String platform,
            String sourceStationKey,
            String gradeCode,
            String gunCode,
            BigDecimal selectedAmount,
            String capturedAt,
            BigDecimal displayPrice,
            BigDecimal stationPrice,
            BigDecimal nationalPrice,
            BigDecimal grossDiscount,
            BigDecimal serviceFee,
            BigDecimal payableAmount,
            String providerName
    ) {
        return "2|" + clean(platform)
                + "|" + clean(sourceStationKey)
                + "|" + clean(gradeCode)
                + "|" + clean(gunCode)
                + "|" + minor(selectedAmount)
                + "|" + CaptureTime.requireUtc(capturedAt)
                + "|" + normalized(displayPrice, 4)
                + "|" + normalized(stationPrice, 4)
                + "|" + normalized(nationalPrice, 4)
                + "|" + minor(grossDiscount)
                + "|" + minor(serviceFee)
                + "|" + minor(payableAmount)
                + "|" + clean(providerName);
    }

    private static void putMoney(JSONObject target, String key, BigDecimal value) {
        put(target, key, value == null ? JSONObject.NULL : money(value).toPlainString());
    }

    private static void putNullable(JSONObject target, String key, String value) {
        put(target, key, clean(value).isEmpty() ? JSONObject.NULL : clean(value));
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化燃油报价", error);
        }
    }

    private static String clean(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }
}
