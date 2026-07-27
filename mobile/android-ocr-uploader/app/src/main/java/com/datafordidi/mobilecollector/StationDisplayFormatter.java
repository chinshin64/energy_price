package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class StationDisplayFormatter {
    private StationDisplayFormatter() {
    }

    static String ports(JSONObject row) {
        JSONObject raw = row == null ? null : row.optJSONObject("raw");
        JSONObject observed = raw == null ? null : raw.optJSONObject("observed");
        boolean present = hasPorts(row) || observed != null && observed.optBoolean("ports", false);
        int available = hasExplicit(row, "availablePorts")
                ? integer(row, "availablePorts")
                : integer(row, "fastIdlePorts") + integer(row, "slowIdlePorts")
                + integer(row, "superIdlePorts");
        int total = hasExplicit(row, "totalPorts")
                ? integer(row, "totalPorts")
                : integer(row, "fastTotalPorts") + integer(row, "slowTotalPorts")
                + integer(row, "superTotalPorts");
        int busy = nullableInteger(row, "busyPorts", Math.max(0, total - available));
        return "闲 " + (present ? available : "—")
                + " / 忙 " + (present ? busy : "—")
                + " / 总 " + (present ? total : "—");
    }

    static String prices(JSONObject row) {
        StringBuilder output = new StringBuilder();
        appendPrice(output, "快", row == null ? null : row.opt("priceFast"));
        appendPrice(output, "慢", row == null ? null : row.opt("priceSlow"));
        appendPrice(output, "超", row == null ? null : row.opt("priceSuper"));
        appendPrice(output, "服务费", row == null ? null : row.opt("priceService"));
        return output.toString();
    }

    static boolean incomplete(JSONObject row) {
        return StationCompletenessPolicy.evaluate(row) != StationCompletenessPolicy.Level.COMPLETE;
    }

    static boolean canEditBackfill(JSONObject row) {
        if (isFuel(row)) return !"synced".equals(row == null ? "" : row.optString("syncState"));
        if (incomplete(row)) return true;
        JSONObject raw = row == null ? null : row.optJSONObject("raw");
        boolean manual = raw != null && raw.optBoolean("manualBackfill", false);
        return manual && !"synced".equals(row.optString("syncState"));
    }

    static boolean hasPrice(JSONObject row) {
        if (isFuel(row)) return fuelOfferCount(row) > 0 || fuelQuoteCount(row) > 0;
        return positive(row, "priceFast") || positive(row, "priceSlow") || positive(row, "priceSuper");
    }

    static boolean hasPorts(JSONObject row) {
        if (row == null) return false;
        JSONObject raw = row.optJSONObject("raw");
        JSONObject observed = raw == null ? null : raw.optJSONObject("observed");
        if (observed != null && observed.has("ports")) {
            return observed.optBoolean("ports", false);
        }
        if (missingField(row, "ports")
                || missingField(row, "availablePorts")
                || missingField(row, "totalPorts")) return false;
        if (positiveTotal(row)) return true;
        JSONObject common = row.optJSONObject("stationObservation");
        return common != null && positiveTotal(common);
    }

    private static boolean positiveTotal(JSONObject row) {
        if (row == null) return false;
        return integer(row, "totalPorts") > 0
                || integer(row, "fastTotalPorts") > 0
                || integer(row, "slowTotalPorts") > 0
                || integer(row, "superTotalPorts") > 0;
    }

    private static boolean missingField(JSONObject row, String expected) {
        JSONArray missing = row == null ? null : row.optJSONArray("missingFields");
        if (missing == null) {
            JSONObject quality = row == null ? null : row.optJSONObject("quality");
            missing = quality == null ? null : quality.optJSONArray("missingFields");
        }
        if (missing == null) return false;
        for (int index = 0; index < missing.length(); index++) {
            if (expected.equals(missing.optString(index))) return true;
        }
        return false;
    }

    static String mainPrice(JSONObject row) {
        if (isFuel(row)) {
            JSONObject offer = firstFuelOffer(row);
            if (offer == null) return "待补油价";
            double value = fuelPrice(offer);
            return value > 0d ? "¥" + decimal(value) + "/升" : "待补油价";
        }
        if (positive(row, "priceFast")) return priceLabel(row.optDouble("priceFast"));
        if (positive(row, "priceSuper")) return priceLabel(row.optDouble("priceSuper"));
        if (positive(row, "priceSlow")) return priceLabel(row.optDouble("priceSlow"));
        return "待补价格";
    }

    static boolean showFeaturedPrice(JSONObject row) {
        return !isFuel(row);
    }

    static String fastPorts(JSONObject row) {
        return typedPorts(row, "快", "fastIdlePorts", "fastTotalPorts");
    }

    static String slowPorts(JSONObject row) {
        return typedPorts(row, "慢", "slowIdlePorts", "slowTotalPorts");
    }

    static String portSummary(JSONObject row) {
        if (isFuel(row)) {
            // 燃油侧无枪数据，不再提示「枪状态待补全」
            return fuelDetails(row);
        }
        StringBuilder output = new StringBuilder();
        appendTypedPorts(output, row, "快", "fastIdlePorts", "fastTotalPorts");
        appendTypedPorts(output, row, "慢", "slowIdlePorts", "slowTotalPorts");
        appendTypedPorts(output, row, "超", "superIdlePorts", "superTotalPorts");
        String common = hasPorts(row) ? "枪：" + ports(row) : "枪状态待补全";
        return output.length() > 0 ? common + "\n" + output : common;
    }

    static String syncStatus(JSONObject row) {
        String state = row == null ? "" : row.optString("syncState");
        JSONObject raw = row == null ? null : row.optJSONObject("raw");
        boolean manualBackfill = raw != null && raw.optBoolean("manualBackfill", false);
        if ("manual-review".equals(state)) return "需人工处理";
        if (manualBackfill && !"synced".equals(state)) return "回填完成·待回传";
        if ("synced".equals(state)) return "47已落库";
        if ("failed".equals(state)) return "待重试";
        if ("local-only".equals(state)) return "仅本地";
        return "待回传";
    }

    static String capturedAt(JSONObject row) {
        return CaptureTime.display(row, ZoneId.systemDefault()).label();
    }

    static String address(JSONObject row) {
        // 燃油侧地址不是采集项，不展示也不提示缺失。
        if (row != null && isFuel(row)) return "";
        if (row == null) return "地址待补全";
        String value = row.isNull("address") ? "" : row.optString("address").trim();
        if (value.isEmpty()) {
            JSONObject common = row.optJSONObject("stationObservation");
            value = common == null || common.isNull("address") ? "" : common.optString("address").trim();
        }
        return value.isEmpty() ? "地址待补全" : value;
    }

    static boolean hasAddress(JSONObject row) {
        // 燃油侧地址不是采集项，视为不缺；充电侧按实际内容判断。
        if (row != null && isFuel(row)) return true;
        return !"地址待补全".equals(address(row));
    }

    static String sourceAgent(JSONObject row) {
        String value = row == null ? "" : row.optString("sourceAgent").trim();
        if (value.isEmpty() && row != null) {
            JSONObject raw = row.optJSONObject("raw");
            value = raw == null ? "" : raw.optString("sourceAgent").trim();
        }
        return value.isEmpty() ? LocalStationStore.SOURCE_AGENT : value;
    }

    static String missingSummary(JSONObject row) {
        StringBuilder output = new StringBuilder();
        if (isFuel(row)) {
            if (!hasPrice(row)) appendMissing(output, "油价");
            return output.length() == 0 ? "字段完整" : "待补：" + output;
        }
        if (!hasAddress(row)) appendMissing(output, "地址");
        if (!hasPorts(row)) appendMissing(output, "枪状态");
        if (!hasPrice(row)) appendMissing(output, "价格");
        return output.length() == 0 ? "字段完整" : "待补：" + output;
    }

    static String editDescription(JSONObject row) {
        String name = row == null ? "" : row.optString("stationName", "").trim();
        return "编辑回填：" + (name.isEmpty() ? "未命名场站" : name);
    }

    static String details(JSONObject row) {
        if (isFuel(row)) return fuelDetails(row);
        StringBuilder output = new StringBuilder("枪：").append(ports(row));
        String priceText = prices(row);
        if (!priceText.isEmpty()) output.append("\n价格：").append(priceText);
        if (incomplete(row)) output.append("\n字段：待补充");
        return output.toString();
    }

    private static void appendPrice(StringBuilder output, String label, Object value) {
        if (!(value instanceof Number)) return;
        if (output.length() > 0) output.append("，");
        output.append(label).append(" ")
                .append(String.format(Locale.CHINA, "%.4f", ((Number) value).doubleValue())
                        .replaceAll("0+$", "").replaceAll("\\.$", ""));
    }

    private static String typedPorts(JSONObject row, String type, String idleKey, String totalKey) {
        int total = integer(row, totalKey);
        if (total <= 0) return type + "：待补";
        int idle = Math.max(0, Math.min(total, integer(row, idleKey)));
        return type + "：闲 " + idle + " / 总 " + total;
    }

    private static void appendTypedPorts(
            StringBuilder output,
            JSONObject row,
            String type,
            String idleKey,
            String totalKey
    ) {
        int total = integer(row, totalKey);
        if (total <= 0) return;
        if (output.length() > 0) output.append("   ");
        int idle = Math.max(0, Math.min(total, integer(row, idleKey)));
        output.append(type).append("：闲 ").append(idle).append(" / 总 ").append(total);
    }

    private static boolean positive(JSONObject row, String key) {
        return row != null && row.opt(key) instanceof Number && row.optDouble(key) > 0d;
    }

    private static int integer(JSONObject row, String key) {
        if (row == null) return 0;
        if (row.has(key) && !row.isNull(key)) return Math.max(0, row.optInt(key));
        JSONObject common = row.optJSONObject("stationObservation");
        return common == null ? 0 : Math.max(0, common.optInt(key));
    }

    private static int nullableInteger(JSONObject row, String key, int fallback) {
        if (row != null && row.has(key) && !row.isNull(key)) return Math.max(0, row.optInt(key));
        JSONObject common = row == null ? null : row.optJSONObject("stationObservation");
        return common != null && common.has(key) && !common.isNull(key)
                ? Math.max(0, common.optInt(key))
                : fallback;
    }

    private static boolean hasExplicit(JSONObject row, String key) {
        if (row != null && row.has(key) && !row.isNull(key)) return true;
        JSONObject common = row == null ? null : row.optJSONObject("stationObservation");
        return common != null && common.has(key) && !common.isNull(key);
    }

    private static void appendMissing(StringBuilder output, String value) {
        if (output.length() > 0) output.append("、");
        output.append(value);
    }

    private static String priceLabel(double value) {
        return "¥" + String.format(Locale.CHINA, "%.4f", value)
                .replaceAll("0+$", "").replaceAll("\\.$", "") + "/度";
    }

    static boolean isFuel(JSONObject row) {
        return row != null && "fuel".equals(row.optString("stationType"));
    }

    static int fuelOfferCount(JSONObject row) {
        JSONObject fuel = row == null ? null : row.optJSONObject("fuelObservation");
        JSONArray offers = fuel == null ? null : fuel.optJSONArray("fuelOffers");
        if (offers == null) return 0;
        int valid = 0;
        for (int index = 0; index < offers.length(); index++) {
            JSONObject offer = offers.optJSONObject(index);
            if (offer != null && fuelPrice(offer) > 0d) valid++;
        }
        return valid;
    }

    static String fuelOfferSummary(JSONObject row) {
        JSONObject fuel = row == null ? null : row.optJSONObject("fuelObservation");
        JSONArray offers = fuel == null ? null : fuel.optJSONArray("fuelOffers");
        if (offers == null || offers.length() == 0) return "待补油价";
        StringBuilder output = new StringBuilder();
        for (int index = 0; index < offers.length(); index++) {
            JSONObject offer = offers.optJSONObject(index);
            if (offer == null) continue;
            double display = positiveNumber(offer, "displayPrice");
            double station = positiveNumber(offer, "stationPrice");
            double national = positiveNumber(offer, "nationalPrice");
            double discount = positiveNumber(offer, "discountPrice");
            double list = positiveNumber(offer, "listPrice");
            double other = positiveNumber(offer, "unclassifiedPrice");
            boolean hasRolePrices = display > 0d || station > 0d || national > 0d;
            if (display <= 0d && station <= 0d && national <= 0d
                    && discount <= 0d && list <= 0d && other <= 0d) {
                continue;
            }
            if (output.length() > 0) output.append("\n");
            output.append(gradeLabel(offer, index));
            if (display > 0d) output.append("  外显 ").append(decimal(display)).append(" 元/升");
            // 油站价/国标价只在数据中存在，不在 UI 展示层显示，避免用户误解为优惠后价格。
            // if (station > 0d) output.append("  油站 ").append(decimal(station)).append(" 元/升");
            // if (national > 0d) output.append("  国标 ").append(decimal(national)).append(" 元/升");
            if (!hasRolePrices && discount > 0d) {
                output.append("  优惠价 ").append(decimal(discount)).append(" 元/升");
            }
            if (!hasRolePrices && list > 0d) {
                output.append("  挂牌价 ").append(decimal(list)).append(" 元/升");
            }
            if (display <= 0d && station <= 0d && national <= 0d
                    && discount <= 0d && list <= 0d) {
                output.append("  ").append(decimal(other)).append(" 元/升");
            }
        }
        return output.length() == 0 ? "待补油价" : output.toString();
    }

    static int fuelQuoteCount(JSONObject row) {
        JSONObject fuel = row == null ? null : row.optJSONObject("fuelObservation");
        JSONArray quotes = fuel == null ? null : fuel.optJSONArray("fuelQuotes");
        return quotes == null ? 0 : quotes.length();
    }

    static String fuelQuoteSummary(JSONObject row) {
        JSONObject fuel = row == null ? null : row.optJSONObject("fuelObservation");
        JSONArray quotes = fuel == null ? null : fuel.optJSONArray("fuelQuotes");
        if (quotes == null || quotes.length() == 0) return "";
        StringBuilder output = new StringBuilder();
        for (int index = 0; index < quotes.length(); index++) {
            JSONObject quote = quotes.optJSONObject(index);
            if (quote == null) continue;
            if (output.length() > 0) output.append("\n");
            output.append(gradeLabel(quote, index));
            String gun = displayText(quote, "gunLabel");
            if (!gun.isEmpty()) output.append(" ").append(gun);
            appendMoney(output, "优惠", quote, "grossDiscount");
            appendMoney(output, "服务费", quote, "serviceFee");
            appendMoney(output, "预计实付", quote, "payableAmount");
            if (quote.optBoolean("needsReview")) output.append("  待核对");
        }
        return output.toString();
    }

    static String fuelDetails(JSONObject row) {
        StringBuilder output = new StringBuilder();
        JSONObject fuel = row == null ? null : row.optJSONObject("fuelObservation");
        String provider = displayText(fuel, "providerName");
        if (!provider.isEmpty()) output.append("服务商：").append(provider);
        String grades = combinedFuelGradeSummary(fuel);
        if (!grades.isEmpty()) {
            if (output.length() > 0) output.append("\n");
            output.append(grades);
        }
        return output.length() == 0 ? "待补油价或报价" : output.toString();
    }

    private static String combinedFuelGradeSummary(JSONObject fuel) {
        if (fuel == null) return "";
        Map<String, FuelGradeDisplay> grades = new LinkedHashMap<>();
        addFuelGradeItems(grades, fuel.optJSONArray("fuelOffers"), true);
        addFuelGradeItems(grades, fuel.optJSONArray("fuelQuotes"), false);
        List<String> ordered = new ArrayList<>();
        if (grades.containsKey("92")) ordered.add("92");
        if (grades.containsKey("95")) ordered.add("95");
        for (String grade : grades.keySet()) {
            if (!ordered.contains(grade)) ordered.add(grade);
        }
        StringBuilder output = new StringBuilder();
        for (String grade : ordered) {
            FuelGradeDisplay item = grades.get(grade);
            if (item == null) continue;
            String line = combinedFuelGradeLine(item);
            if (line.isEmpty()) continue;
            if (output.length() > 0) output.append("\n");
            output.append(line);
        }
        return output.toString();
    }

    private static void addFuelGradeItems(
            Map<String, FuelGradeDisplay> grades,
            JSONArray values,
            boolean offer
    ) {
        if (values == null) return;
        for (int index = 0; index < values.length(); index++) {
            JSONObject value = values.optJSONObject(index);
            if (value == null) continue;
            String grade = gradeKey(value, index);
            FuelGradeDisplay item = grades.get(grade);
            if (item == null) {
                item = new FuelGradeDisplay(gradeLabel(value, index));
                grades.put(grade, item);
            }
            if (offer) item.offer = value;
            else item.quote = value;
        }
    }

    private static String combinedFuelGradeLine(FuelGradeDisplay item) {
        StringBuilder output = new StringBuilder(item.label);
        JSONObject offer = item.offer;
        double display = positiveNumber(offer, "displayPrice");
        if (display > 0d) {
            output.append("  外显").append(decimal(display)).append("/升");
        } else {
            double fallback = fuelPrice(offer);
            if (fallback > 0d) output.append("  油价").append(decimal(fallback)).append("/升");
        }
        appendCompactMoney(output, "优惠", item.quote, "grossDiscount");
        appendCompactMoney(output, "服务费", item.quote, "serviceFee");
        appendCompactMoney(output, "实付", item.quote, "payableAmount");
        return output.length() == item.label.length() ? "" : output.toString();
    }

    private static String gradeKey(JSONObject value, int index) {
        String code = displayText(value, "gradeCode").replace("#", "");
        if (!code.isEmpty()) return code;
        String label = displayText(value, "gradeLabel").replace("#", "");
        return label.isEmpty() ? "unknown-" + index : label;
    }

    private static String gradeLabel(JSONObject value, int index) {
        String label = displayText(value, "gradeLabel");
        if (!label.isEmpty()) return label;
        String code = displayText(value, "gradeCode");
        return code.isEmpty() ? "油号待补" : code + (code.endsWith("#") ? "" : "#");
    }

    private static String displayText(JSONObject value, String key) {
        if (value == null || value.isNull(key)) return "";
        String text = value.optString(key, "").trim();
        return text.isEmpty()
                || "null".equalsIgnoreCase(text)
                || "undefined".equalsIgnoreCase(text)
                ? ""
                : text;
    }

    private static JSONObject firstFuelOffer(JSONObject row) {
        JSONObject fuel = row == null ? null : row.optJSONObject("fuelObservation");
        JSONArray offers = fuel == null ? null : fuel.optJSONArray("fuelOffers");
        return offers == null ? null : offers.optJSONObject(0);
    }

    private static double fuelPrice(JSONObject offer) {
        double display = positiveNumber(offer, "displayPrice");
        if (display > 0d) return display;
        double discount = positiveNumber(offer, "discountPrice");
        if (discount > 0d) return discount;
        double station = positiveNumber(offer, "stationPrice");
        if (station > 0d) return station;
        double national = positiveNumber(offer, "nationalPrice");
        if (national > 0d) return national;
        double list = positiveNumber(offer, "listPrice");
        if (list > 0d) return list;
        return positiveNumber(offer, "unclassifiedPrice");
    }

    private static double positiveNumber(JSONObject value, String key) {
        Object raw = value == null ? null : value.opt(key);
        try {
            double number = raw instanceof Number
                    ? ((Number) raw).doubleValue()
                    : raw instanceof String ? new BigDecimal((String) raw).doubleValue() : 0d;
            return number > 0d ? number : 0d;
        } catch (NumberFormatException ignored) {
            return 0d;
        }
    }

    private static void appendMoney(StringBuilder output, String label, JSONObject value, String key) {
        if (value == null || value.isNull(key)) return;
        try {
            BigDecimal amount = new BigDecimal(value.optString(key));
            output.append("  ").append(label).append(" ¥")
                    .append(amount.setScale(2, java.math.RoundingMode.HALF_UP).toPlainString());
        } catch (NumberFormatException ignored) {
            // Invalid display-only values are omitted.
        }
    }

    private static void appendCompactMoney(
            StringBuilder output,
            String label,
            JSONObject value,
            String key
    ) {
        if (value == null || value.isNull(key)) return;
        try {
            BigDecimal amount = new BigDecimal(value.optString(key));
            output.append("  ").append(label)
                    .append(amount.setScale(2, java.math.RoundingMode.HALF_UP).toPlainString());
        } catch (NumberFormatException ignored) {
            // Invalid display-only values are omitted.
        }
    }

    private static String decimal(double value) {
        return BigDecimal.valueOf(value).stripTrailingZeros().toPlainString();
    }

    private static final class FuelGradeDisplay {
        final String label;
        JSONObject offer;
        JSONObject quote;

        FuelGradeDisplay(String label) {
            this.label = label;
        }
    }
}
