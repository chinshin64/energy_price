package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 燃油卡片解析器接口与共享工具。
 *
 * <p>每种平台（团油、高德加油、通用燃油）实现此接口，按统一流程解析 OCR rows。
 */
interface FuelCardParser {

    FuelParseResult parse(List<OcrRow> rows, String platform, String sourceStage);

    /**
     * 解析结果。
     */
    final class FuelParseResult {
        final List<FuelStationRecord> stations;
        final List<String> rejectionReasons;
        final List<JSONObject> priceEvidence;

        FuelParseResult(
                List<FuelStationRecord> stations,
                List<String> rejectionReasons,
                List<JSONObject> priceEvidence
        ) {
            this.stations = stations == null ? new ArrayList<>() : stations;
            this.rejectionReasons = rejectionReasons == null ? new ArrayList<>() : rejectionReasons;
            this.priceEvidence = priceEvidence == null ? new ArrayList<>() : priceEvidence;
        }

        static FuelParseResult empty() {
            return new FuelParseResult(new ArrayList<>(), new ArrayList<>(), new ArrayList<>());
        }
    }

    /**
     * 卡片内价格解释器。
     */
    final class InterpretedPrice {
        final BigDecimal value;
        final PriceRole role;
        final OcrRow evidence;
        final String gradeCode; // 若价格行本身带油号

        InterpretedPrice(BigDecimal value, PriceRole role, OcrRow evidence, String gradeCode) {
            this.value = value;
            this.role = role;
            this.evidence = evidence;
            this.gradeCode = gradeCode == null ? "" : gradeCode;
        }
    }

    enum PriceRole {
        LIST,       // 挂牌价
        DISCOUNT,   // 优惠价 / 折后价
        DISPLAY,    // 外显价 / 团油价 / 高德价 / 加油价
        STATION,    // 油站价
        NATIONAL,   // 国标价
        UNCLASSIFIED,
        BLOCKED
    }

    /**
     * 将 OCR rows 按油号归类到同一张卡片。
     */
    final class GradeCard {
        final String gradeCode; // 例如 "92"
        final String gradeLabel; // 例如 "92#"
        final List<OcrRow> rows;

        GradeCard(String gradeCode, String gradeLabel, List<OcrRow> rows) {
            this.gradeCode = gradeCode;
            this.gradeLabel = gradeLabel;
            this.rows = rows;
        }
    }

    /**
     * 基础工具方法。
     */
    final class Utilities {
        private static final Pattern GRADE = Pattern.compile(
                "(?<!\\d)(-10|90|92|95|98|101|0)\\s*[#＃](?:\\s*(汽油|柴油|甲醇))?"
        );
        private static final Pattern PRICE = Pattern.compile(
                "(?:[¥￥vVxX]\\s*)?([0-9]{1,4}(?:[.,][0-9]{1,4})?)\\s*(?:元)?\\s*(?:/\\s*(?:L|l|升))?"
        );
        private static final Pattern DISTANCE = Pattern.compile("\\d+(?:\\.\\d+)?\\s*(?:km|KM|公里|m|米)");
        private static final Pattern TIME = Pattern.compile("\\d{1,2}:\\d{2}");
        private static final Pattern PROMOTION = Pattern.compile(
                "(?:加\\s*\\d+\\s*(?:省|减|立减|直降)|省\\s*\\d|前\\s*\\d+\\s*升|加满\\s*\\d|满\\s*\\d+\\s*(?:减|省|送)|24\\s*[时点]|\\d{1,2}\\s*时\\s*营业)"
        );

        private Utilities() {
        }

        static List<OcrRow> sortedCopy(List<OcrRow> rows) {
            List<OcrRow> copy = new ArrayList<>(rows == null ? Collections.emptyList() : rows);
            copy.sort(Comparator.comparingDouble((OcrRow row) -> row.y).thenComparingDouble(row -> row.x));
            return copy;
        }

        static String clean(String value) {
            return value == null ? "" : value.replaceAll("\\s+", "").trim();
        }

        static String gradeCode(String text) {
            Matcher matcher = GRADE.matcher(clean(text));
            return matcher.find() ? matcher.group(1) : "";
        }

        static Pattern gradePattern() {
            return GRADE;
        }

        static String gradeLabel(String code) {
            return code.isEmpty() ? "" : code + "#";
        }

        static String fuelType(String grade) {
            return "0#".equals(grade) || "-10#".equals(grade) ? "diesel" : "gasoline";
        }

        static List<BigDecimal> prices(String text) {
            List<BigDecimal> output = new ArrayList<>();
            Matcher matcher = PRICE.matcher(clean(text));
            while (matcher.find()) {
                String token = matcher.group(1).replace(',', '.');
                try {
                    BigDecimal decimal = new BigDecimal(token).stripTrailingZeros();
                    if (decimal.scale() <= 4 && FuelOffer.validRolePrice(decimal)) output.add(decimal);
                } catch (NumberFormatException ignored) {
                }
            }
            return output;
        }

        static PriceRole priceRole(String text) {
            String value = clean(text);
            if (blocked(value)) return PriceRole.BLOCKED;
            if (value.contains("油站价")) return PriceRole.STATION;
            if (value.contains("国标价")) return PriceRole.NATIONAL;
            if (value.contains("外显价") || value.contains("团油价")
                    || value.contains("高德价") || value.contains("加油价")) {
                return PriceRole.DISPLAY;
            }
            if (value.contains("挂牌价")) return PriceRole.LIST;
            if (value.contains("优惠价") || value.contains("折后价")) return PriceRole.DISCOUNT;
            if ((value.contains("元/L") || value.contains("元/升"))
                    && !value.matches(".*(?:油站价|国标价|挂牌价|外显价|团油价|高德价|加油价|优惠价|折后价).*")) {
                return PriceRole.UNCLASSIFIED;
            }
            return PriceRole.UNCLASSIFIED;
        }

        static boolean blocked(String text) {
            String value = clean(text);
            return value.contains("订单")
                    || value.contains("实付")
                    || value.contains("支付")
                    || value.contains("优惠券")
                    || value.contains("券后")
                    || value.contains("满")
                    || value.contains("会员")
                    || value.contains("停车费")
                    || value.contains("服务费")
                    || value.contains("起")
                    || value.contains("营业")
                    || value.contains("限时")
                    || value.contains("保障")
                    || value.contains("开票")
                    || value.contains("发票")
                    || PROMOTION.matcher(value).find()
                    || DISTANCE.matcher(value).find()
                    || TIME.matcher(value).find();
        }

        static boolean blockedInStationList(String text) {
            String value = clean(text);
            return blocked(value)
                    || value.contains("立减")
                    || value.contains("直降")
                    || value.contains("省");
        }

        static boolean isTitleNoise(String text) {
            String value = clean(text);
            if (value.length() < 5 || value.length() > 48) return true;
            if (value.contains("优惠加油") || value.contains("到站选油号")
                    || value.contains("油站确认") || value.contains("选择油枪")
                    || value.contains("立即加油") || value.contains("输入加油金额")
                    || value.contains("输入金额计算优惠") || value.contains("输入金额查看优惠金额")) {
                return true;
            }
            if (value.contains("有效") || value.contains("可用") || value.contains("优惠券")
                    || value.contains("券") || value.matches(".*\\d+\\s*天.*")) {
                return true;
            }
            return false;
        }

        static boolean looksLikeStationName(String text) {
            String value = clean(FuelStationNameNormalizer.normalize(text));
            if (isTitleNoise(value)) return false;
            // 排除价格标签行被误识别为站名。
            if (priceRole(text) != PriceRole.UNCLASSIFIED) return false;
            if (value.contains("价") || value.matches(".*\\d+(?:[.,]\\d+)?\\s*(?:元|/L|/升).*")) return false;
            if (value.contains("加油站") || value.contains("油站") || value.contains("石油")
                    || value.contains("石化") || value.contains("能源") && value.endsWith("站")) {
                return true;
            }
            return false;
        }

        static float centerX(OcrRow row) {
            return row.x + row.width / 2f;
        }

        static boolean sameColumn(OcrRow a, OcrRow b) {
            float radius = Math.max(0.24f, Math.min(0.34f, (a.width + b.width) * 0.65f));
            return Math.abs(centerX(a) - centerX(b)) <= radius;
        }

        static List<OcrRow> cardRows(List<OcrRow> rows, OcrRow title, float bottom) {
            List<OcrRow> output = new ArrayList<>();
            for (OcrRow row : rows) {
                if (row.y + row.height < title.y - 0.006f || row.y > bottom) continue;
                if (sameColumn(row, title)) output.add(row);
            }
            return output;
        }

        static String cleanStationName(String value) {
            return FuelStationNameNormalizer.normalize(value);
        }

        static Map<String, GradeCard> splitByGrade(List<OcrRow> rows) {
            Map<String, GradeCard> cards = new LinkedHashMap<>();
            String currentCode = "";
            String currentLabel = "";
            List<OcrRow> currentRows = new ArrayList<>();
            for (OcrRow row : rows) {
                String code = gradeCode(row.text);
                if (!code.isEmpty() && !code.equals(currentCode)) {
                    if (!currentCode.isEmpty()) {
                        cards.put(currentCode, new GradeCard(currentCode, currentLabel, currentRows));
                    }
                    currentCode = code;
                    currentLabel = gradeLabel(code);
                    currentRows = new ArrayList<>();
                }
                currentRows.add(row);
            }
            if (!currentCode.isEmpty()) {
                cards.put(currentCode, new GradeCard(currentCode, currentLabel, currentRows));
            }
            return cards;
        }
    }
}
