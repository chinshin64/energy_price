package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 高德燃油详情页与支付页的会话内合并器。
 *
 * <p>明确油号优先；无油号支付页先按油站与外显价暂存，出现同站第二档价格后再按
 * “低价 92、高价 95”生成记录。该类不持有 Android Context，生命周期由采集服务管理。
 */
final class AmapFuelSessionReconciler {
    private static final int MAX_STATIONS = 64;
    private static final BigDecimal MIN_GRADE_GAP = new BigDecimal("0.05");
    private static final BigDecimal MAX_GRADE_GAP = new BigDecimal("3.00");
    private static final Pattern PRICE_PER_LITER = Pattern.compile(
            "(?:[¥￥vVxX]\\s*)?([0-9]{1,2}(?:[.,][0-9]{1,4})?)\\s*(?:元)?\\s*/\\s*(?:L|l|升)"
    );
    private static final Pattern DISPLAY_BEFORE_SAVE = Pattern.compile(
            "(?:[¥￥vVxX]\\s*)?([0-9]{1,2}[.,][0-9]{1,4}).{0,12}"
                    + "(?:加|充)\\s*200.*(?:省|减|优惠)"
    );

    private final Map<String, StationState> states =
            new LinkedHashMap<String, StationState>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, StationState> eldest) {
                    return size() > MAX_STATIONS;
                }
            };

    void reset() {
        states.clear();
    }

    Result reconcile(
            String platform,
            List<OcrRow> rows,
            List<FuelStationRecord> parsedStations
    ) {
        if (!"amap-fuel".equals(clean(platform))) {
            return new Result(copyList(parsedStations), false, null);
        }
        List<FuelStationRecord> output = new ArrayList<>();
        boolean waitingForPair = false;
        PendingPreview preview = null;
        if (parsedStations == null) return new Result(output, false, null);

        for (FuelStationRecord station : parsedStations) {
            if (station == null || clean(station.stationName).isEmpty()) continue;
            StationState state = state(station);
            cacheExplicitOffers(state, station);

            if (!isPaymentRecord(station, rows)) {
                // 详情页只做前置缓存；“加 200 约省”不是最终支付报价，不能提前落库。
                preview = preview(station, firstQuote(station), paymentDisplayPrice(rows));
                station.fuelQuotes.clear();
                waitingForPair = true;
                continue;
            }

            FuelQuote quote = firstQuote(station);
            if (quote == null) continue;
            PriceObservation paymentPrice = paymentDisplayPrice(rows);
            String explicitGrade = uniqueExplicitGrade(rows);
            if (!explicitGrade.isEmpty()) {
                FuelStationRecord resolved = resolveSingle(
                        state, station, quote, explicitGrade, paymentPrice, false
                );
                if (resolved == null) {
                    preview = preview(station, quote, paymentPrice);
                    waitingForPair = true;
                }
                else output.add(resolved);
                continue;
            }

            String cachedGrade = state.gradeFor(paymentPrice == null ? null : paymentPrice.value);
            if (!cachedGrade.isEmpty()) {
                FuelStationRecord resolved = resolveSingle(
                        state, station, quote, cachedGrade, paymentPrice, false
                );
                if (resolved == null) {
                    preview = preview(station, quote, paymentPrice);
                    waitingForPair = true;
                }
                else output.add(resolved);
                continue;
            }

            if (paymentPrice == null || state.inferenceAmbiguous) {
                preview = preview(station, quote, paymentPrice);
                waitingForPair = true;
                continue;
            }
            if (state.gradeByDisplayPrice.size() >= 2
                    && !state.gradeByDisplayPrice.containsKey(normalize(paymentPrice.value))) {
                state.inferenceAmbiguous = true;
                state.pending.clear();
                preview = preview(station, quote, paymentPrice);
                waitingForPair = true;
                continue;
            }

            BigDecimal priceKey = normalize(paymentPrice.value);
            state.pending.put(priceKey, new Pending(station, quote, paymentPrice));
            if (state.pending.size() < 2) {
                preview = preview(station, quote, paymentPrice);
                waitingForPair = true;
                continue;
            }
            if (state.pending.size() > 2) {
                state.inferenceAmbiguous = true;
                state.pending.clear();
                preview = preview(station, quote, paymentPrice);
                waitingForPair = true;
                continue;
            }

            List<Pending> pair = new ArrayList<>(state.pending.values());
            pair.sort(Comparator.comparing(item -> item.price.value));
            BigDecimal gap = pair.get(1).price.value.subtract(pair.get(0).price.value).abs();
            if (gap.compareTo(MIN_GRADE_GAP) < 0 || gap.compareTo(MAX_GRADE_GAP) > 0
                    || providersConflict(pair.get(0).station, pair.get(1).station)) {
                preview = preview(station, quote, paymentPrice);
                waitingForPair = true;
                continue;
            }

            FuelStationRecord combined = combinePair(state, pair.get(0), pair.get(1));
            state.pending.clear();
            output.add(combined);
        }
        return new Result(
                output,
                waitingForPair && output.isEmpty(),
                output.isEmpty() ? preview : null
        );
    }

    Result reconcileGuided(
            String platform,
            List<OcrRow> rows,
            List<FuelStationRecord> parsedStations,
            String expectedGrade
    ) {
        List<FuelStationRecord> output = new ArrayList<>();
        PendingPreview pendingPreview = null;
        if (!"amap-fuel".equals(clean(platform))
                || !isSupportedGrade(expectedGrade)
                || parsedStations == null) {
            return new Result(output, false, null);
        }
        for (FuelStationRecord station : parsedStations) {
            if (station == null || clean(station.stationName).isEmpty()) continue;
            StationState state = state(station);
            cacheExplicitOffers(state, station);
            FuelQuote quote = firstQuote(station);
            PriceObservation displayPrice = paymentDisplayPrice(rows);
            pendingPreview = preview(station, quote, displayPrice);
            if (!isGuidedPaymentComplete(station, quote, displayPrice)) continue;
            FuelStationRecord resolved = resolveSingle(
                    state,
                    station,
                    quote,
                    expectedGrade,
                    displayPrice,
                    false
            );
            if (resolved == null) continue;
            resolved.localParser = "amap-guided-" + expectedGrade;
            output.add(resolved);
            break;
        }
        return new Result(
                output,
                output.isEmpty(),
                output.isEmpty() ? pendingPreview : null
        );
    }

    private static boolean isGuidedPaymentComplete(
            FuelStationRecord station,
            FuelQuote quote,
            PriceObservation displayPrice
    ) {
        return station != null
                && quote != null
                && displayPrice != null
                && quote.grossDiscount != null
                && quote.serviceFee != null
                && quote.payableAmount != null
                && !clean(station.providerName).isEmpty()
                && station.providerEvidence != null;
    }

    private static PendingPreview preview(
            FuelStationRecord station,
            FuelQuote quote,
            PriceObservation paymentPrice
    ) {
        BigDecimal displayPrice = paymentPrice == null ? null : paymentPrice.value;
        if (displayPrice == null && station != null) {
            for (FuelOffer offer : station.fuelOffers) {
                if (offer != null && offer.displayPrice != null) {
                    displayPrice = offer.displayPrice;
                    break;
                }
            }
        }
        return new PendingPreview(
                station == null ? "" : clean(station.stationName),
                displayPrice,
                quote == null ? null : quote.grossDiscount,
                quote == null ? null : quote.serviceFee,
                quote == null ? null : quote.payableAmount,
                station == null ? "" : clean(station.providerName)
        );
    }

    private StationState state(FuelStationRecord station) {
        String key = normalizeStationName(station.stationName);
        StationState state = states.get(key);
        if (state == null) {
            state = new StationState();
            state.stationName = station.stationName;
            state.captureContextId = clean(station.captureContextId);
            states.put(key, state);
        } else if (state.captureContextId.isEmpty() && !clean(station.captureContextId).isEmpty()) {
            state.captureContextId = station.captureContextId;
        }
        return state;
    }

    private void cacheExplicitOffers(StationState state, FuelStationRecord station) {
        for (FuelOffer offer : station.fuelOffers) {
            if (offer == null || !isSupportedGrade(offer.gradeCode) || !offer.valid()) continue;
            FuelOffer copied = copyOffer(offer);
            state.offersByGrade.put(copied.gradeCode, copied);
            if (copied.displayPrice != null) {
                state.gradeByDisplayPrice.put(normalize(copied.displayPrice), copied.gradeCode);
            }
        }
    }

    private FuelStationRecord resolveSingle(
            StationState state,
            FuelStationRecord station,
            FuelQuote quote,
            String grade,
            PriceObservation paymentPrice,
            boolean ranked
    ) {
        FuelOffer cached = state.offersByGrade.get(grade);
        FuelOffer offer = cached == null ? newOffer(grade) : copyOffer(cached);
        if (paymentPrice != null) applyPaymentDisplayPrice(offer, paymentPrice);
        if (!offer.valid()) return null;
        finishQuote(quote, grade);

        station.fuelOffers.clear();
        station.fuelOffers.add(offer);
        station.fuelQuotes.clear();
        station.fuelQuotes.add(quote);
        station.captureContextId = stableContext(state, station);
        station.localParser = ranked
                ? "amap-payment-display-price-ranking"
                : "amap-detail-payment-reconciled";
        state.offersByGrade.put(grade, copyOffer(offer));
        if (offer.displayPrice != null) {
            state.gradeByDisplayPrice.put(normalize(offer.displayPrice), grade);
        }
        return station;
    }

    private FuelStationRecord combinePair(
            StationState state,
            Pending lower,
            Pending higher
    ) {
        FuelStationRecord combined = copyBase(higher.station);
        combined.stationName = state.stationName;
        combined.captureContextId = stableContext(state, combined);
        combined.localParser = "amap-payment-display-price-ranking";
        if (clean(combined.providerName).isEmpty()) {
            combined.providerName = lower.station.providerName;
            combined.providerEvidence = copyObject(lower.station.providerEvidence);
        }

        FuelStationRecord resolved92 = resolveSingle(
                state, lower.station, lower.quote, "92", lower.price, true
        );
        FuelStationRecord resolved95 = resolveSingle(
                state, higher.station, higher.quote, "95", higher.price, true
        );
        combined.fuelOffers.add(copyOffer(resolved92.fuelOffers.get(0)));
        combined.fuelOffers.add(copyOffer(resolved95.fuelOffers.get(0)));
        combined.fuelQuotes.add(resolved92.fuelQuotes.get(0));
        combined.fuelQuotes.add(resolved95.fuelQuotes.get(0));
        return combined;
    }

    private static void finishQuote(FuelQuote quote, String grade) {
        quote.gradeCode = grade;
        quote.gradeLabel = grade + "#";
        // 排序推断已由同站双价格和边界规则确认；推断来源记录在 localParser。
        quote.gradeInferred = false;
        quote.validateFormula();
    }

    private static void applyPaymentDisplayPrice(FuelOffer offer, PriceObservation observation) {
        offer.displayPrice = observation.value;
        put(offer.fieldSource, "displayPrice", "ocr");
        JSONObject evidence = new JSONObject();
        put(evidence, "kind", "amap-payment-display-price");
        JSONObject box = new JSONObject();
        put(box, "x", observation.row.x);
        put(box, "y", observation.row.y);
        put(box, "width", observation.row.width);
        put(box, "height", observation.row.height);
        put(evidence, "boundingBox", box);
        offer.evidence.put(evidence);
    }

    private static FuelOffer newOffer(String grade) {
        FuelOffer offer = new FuelOffer();
        offer.fuelType = "gasoline";
        offer.gradeCode = grade;
        offer.gradeLabel = grade + "#";
        return offer;
    }

    private static FuelOffer copyOffer(FuelOffer source) {
        FuelOffer output = new FuelOffer();
        output.fuelType = source.fuelType;
        output.gradeCode = source.gradeCode;
        output.gradeLabel = source.gradeLabel;
        output.listPrice = source.listPrice;
        output.discountPrice = source.discountPrice;
        output.unclassifiedPrice = source.unclassifiedPrice;
        output.displayPrice = source.displayPrice;
        output.stationPrice = source.stationPrice;
        output.nationalPrice = source.nationalPrice;
        output.discountKind = source.discountKind;
        output.evidence = copyArray(source.evidence);
        output.fieldSource = copyObject(source.fieldSource);
        output.capturedAt = source.capturedAt;
        return output;
    }

    private static FuelStationRecord copyBase(FuelStationRecord source) {
        FuelStationRecord output = new FuelStationRecord();
        output.platform = source.platform;
        output.stationName = source.stationName;
        output.capturedAt = source.capturedAt;
        output.sourceStage = source.sourceStage;
        output.localParser = source.localParser;
        output.captureMode = source.captureMode;
        output.packageCategory = source.packageCategory;
        output.captureContextId = source.captureContextId;
        output.providerName = source.providerName;
        output.providerEvidence = copyObject(source.providerEvidence);
        output.observedStationName = source.observedStationName;
        output.stationNameMatchMethod = source.stationNameMatchMethod;
        return output;
    }

    private static JSONArray copyArray(JSONArray source) {
        JSONArray output = new JSONArray();
        if (source == null) return output;
        for (int index = 0; index < source.length(); index++) {
            JSONObject value = source.optJSONObject(index);
            if (value != null) output.put(AddressFreePayload.copyObject(value));
        }
        return output;
    }

    private static JSONObject copyObject(JSONObject source) {
        return source == null ? null : AddressFreePayload.copyObject(source);
    }

    private static String stableContext(StationState state, FuelStationRecord station) {
        if (!state.captureContextId.isEmpty()) return state.captureContextId;
        String existing = clean(station.captureContextId);
        if (!existing.isEmpty()) {
            state.captureContextId = existing;
            return existing;
        }
        state.captureContextId = DeviceIdentity.sha256(
                "amap-fuel|" + normalizeStationName(station.stationName)
        ).substring(0, 12);
        return state.captureContextId;
    }

    private static FuelQuote firstQuote(FuelStationRecord station) {
        for (FuelQuote quote : station.fuelQuotes) {
            if (quote != null && quote.valid()) return quote;
        }
        return null;
    }

    private static boolean isPaymentRecord(FuelStationRecord station, List<OcrRow> rows) {
        FuelQuote quote = firstQuote(station);
        if (quote == null) return false;
        if (quote.payableAmount != null || !clean(station.providerName).isEmpty()) return true;
        for (OcrRow row : safeRows(rows)) {
            String text = clean(row.text);
            if (text.contains("实付") || text.contains("应付")
                    || text.contains("服务商") && text.contains("提供")) {
                return true;
            }
        }
        return false;
    }

    private static PriceObservation paymentDisplayPrice(List<OcrRow> rows) {
        PriceObservation fallback = null;
        for (OcrRow row : safeRows(rows)) {
            String text = clean(row.text);
            if (text.contains("油站价") || text.contains("国标价") || text.contains("挂牌价")) continue;
            Matcher matcher = PRICE_PER_LITER.matcher(text);
            while (matcher.find()) {
                BigDecimal price = decimal(matcher.group(1));
                if (price == null || !FuelOffer.validRolePrice(price)) continue;
                PriceObservation candidate = new PriceObservation(price, row);
                if (text.matches(".*(?:加|充)200.*(?:省|减|优惠).*")) return candidate;
                if (fallback == null || row.y < fallback.row.y) fallback = candidate;
            }
            Matcher displayBeforeSave = DISPLAY_BEFORE_SAVE.matcher(text);
            if (displayBeforeSave.find()) {
                BigDecimal price = decimal(displayBeforeSave.group(1));
                if (price != null && FuelOffer.validRolePrice(price)) {
                    return new PriceObservation(price, row);
                }
            }
        }
        return fallback;
    }

    private static String uniqueExplicitGrade(List<OcrRow> rows) {
        Set<String> grades = new LinkedHashSet<>();
        for (OcrRow row : safeRows(rows)) {
            Matcher matcher = FuelCardParser.Utilities.gradePattern().matcher(row.text);
            while (matcher.find()) {
                String grade = matcher.group(1);
                if (isSupportedGrade(grade)) grades.add(grade);
            }
        }
        return grades.size() == 1 ? grades.iterator().next() : "";
    }

    private static boolean providersConflict(FuelStationRecord first, FuelStationRecord second) {
        String left = clean(first.providerName);
        String right = clean(second.providerName);
        return !left.isEmpty() && !right.isEmpty() && !left.equals(right);
    }

    private static boolean isSupportedGrade(String grade) {
        return "92".equals(clean(grade)) || "95".equals(clean(grade));
    }

    private static List<FuelStationRecord> copyList(List<FuelStationRecord> source) {
        return source == null ? new ArrayList<>() : new ArrayList<>(source);
    }

    private static List<OcrRow> safeRows(List<OcrRow> rows) {
        return rows == null ? Collections.emptyList() : rows;
    }

    private static BigDecimal decimal(String value) {
        try {
            return normalize(new BigDecimal(clean(value).replace(',', '.')));
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static BigDecimal normalize(BigDecimal value) {
        return value == null ? null : value.stripTrailingZeros();
    }

    private static String normalizeStationName(String value) {
        return clean(value)
                .replaceAll("[（）()·•\\-—_]", "")
                .toLowerCase(java.util.Locale.ROOT);
    }

    private static String clean(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法记录高德燃油推断证据", error);
        }
    }

    static final class Result {
        final List<FuelStationRecord> stations;
        final boolean waitingForPair;
        final PendingPreview pendingPreview;

        Result(
                List<FuelStationRecord> stations,
                boolean waitingForPair,
                PendingPreview pendingPreview
        ) {
            this.stations = stations;
            this.waitingForPair = waitingForPair;
            this.pendingPreview = pendingPreview;
        }
    }

    static final class PendingPreview {
        final String stationName;
        final BigDecimal displayPrice;
        final BigDecimal grossDiscount;
        final BigDecimal serviceFee;
        final BigDecimal payableAmount;
        final String providerName;

        PendingPreview(
                String stationName,
                BigDecimal displayPrice,
                BigDecimal grossDiscount,
                BigDecimal serviceFee,
                BigDecimal payableAmount,
                String providerName
        ) {
            this.stationName = stationName;
            this.displayPrice = displayPrice;
            this.grossDiscount = grossDiscount;
            this.serviceFee = serviceFee;
            this.payableAmount = payableAmount;
            this.providerName = providerName;
        }
    }

    private static final class StationState {
        String stationName = "";
        String captureContextId = "";
        boolean inferenceAmbiguous;
        final Map<String, FuelOffer> offersByGrade = new LinkedHashMap<>();
        final Map<BigDecimal, String> gradeByDisplayPrice = new LinkedHashMap<>();
        final Map<BigDecimal, Pending> pending = new LinkedHashMap<>();

        String gradeFor(BigDecimal displayPrice) {
            if (displayPrice == null) return "";
            String grade = gradeByDisplayPrice.get(normalize(displayPrice));
            return grade == null ? "" : grade;
        }
    }

    private static final class Pending {
        final FuelStationRecord station;
        final FuelQuote quote;
        final PriceObservation price;

        Pending(FuelStationRecord station, FuelQuote quote, PriceObservation price) {
            this.station = station;
            this.quote = quote;
            this.price = price;
        }
    }

    private static final class PriceObservation {
        final BigDecimal value;
        final OcrRow row;

        PriceObservation(BigDecimal value, OcrRow row) {
            this.value = value;
            this.row = row;
        }
    }
}
