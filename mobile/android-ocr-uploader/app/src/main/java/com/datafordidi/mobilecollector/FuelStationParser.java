package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class FuelStationParser {
    private static final Pattern GRADE = Pattern.compile(
            "(?<!\\d)(-10|90|92|95|98|101|0)\\s*[#＃](?:\\s*(汽油|柴油|甲醇))?"
    );
    private static final Pattern PRICE = Pattern.compile(
            "(?:[¥￥vVxX]\\s*)?([0-9]{1,2}(?:[.,][0-9]{1,4})?)\\s*(?:元)?\\s*(?:/\\s*(?:L|l|升))?"
    );
    private static final Pattern DISTANCE = Pattern.compile("\\d+(?:\\.\\d+)?\\s*(?:km|KM|公里|m|米)");
    private static final Pattern TIME = Pattern.compile("\\d{1,2}:\\d{2}");
    private static final Pattern MONEY = Pattern.compile(
            "(?:[¥￥]\\s*)?([0-9]{1,6}(?:[.,][0-9]{1,2})?)\\s*(?:元)?"
    );
    private static final Pattern GUN = Pattern.compile("(?<!\\d)([0-9]{1,3})\\s*号?\\s*枪");
    private static final Pattern PROVIDER = Pattern.compile(
            "(?:CP|cp|服务商|服务提供方)\\s*[:：]?\\s*([\\u4e00-\\u9fa5A-Za-z0-9（）()·\\-]{2,40})"
    );
    private static final Pattern PROVIDED_BY = Pattern.compile(
            "(?:本服务)?由\\s*([\\u4e00-\\u9fa5A-Za-z0-9（）()·\\-]{2,40})\\s*提供"
    );
    // 高德页面底部「本次由服务商"团油"提供」格式：CP 名在引号内，引号字符不在原字符集，需单独匹配。
    private static final Pattern PROVIDED_BY_QUOTED = Pattern.compile(
            "(?:本服务)?由\\s*服务商?\\s*[\"“”‘’']\\s*([\\u4e00-\\u9fa5A-Za-z0-9（）()·\\-]{2,40})\\s*[\"“”‘’']\\s*提供"
    );

    private FuelStationParser() {
    }

    static List<FuelStationRecord> extract(
            List<OcrRow> inputRows,
            String platform,
            String sourceStage
    ) {
        List<FuelStationRecord> output = new ArrayList<>();
        if (inputRows == null || inputRows.isEmpty() || clean(platform).isEmpty()) return output;
        List<OcrRow> rows = new ArrayList<>(inputRows);
        rows.sort(Comparator.comparingDouble((OcrRow row) -> row.y).thenComparingDouble(row -> row.x));
        String globalGrade = globalGrade(rows);
        List<OcrRow> titles = titles(rows);
        for (int index = 0; index < titles.size(); index++) {
            OcrRow title = titles.get(index);
            OcrRow nextTitle = nextTitleInColumn(titles, title);
            float bottom = nextTitle == null
                    ? Math.min(1f, title.y + 0.24f)
                    : nextTitle.y - 0.006f;
            List<OcrRow> card = card(rows, title, bottom);
            FuelStationRecord station = parseCard(title, card, globalGrade, platform, sourceStage);
            if (station != null) output.add(station);
        }
        FuelQuote quote = quote(rows);
        Provider provider = provider(rows);
        if (output.isEmpty() && titles.size() == 1 && quote != null) {
            FuelStationRecord station = emptyStation(
                    titles.get(0), platform, sourceStage
            );
            output.add(station);
        }
        if (output.size() == 1) {
            FuelStationRecord station = output.get(0);
            if (provider != null) {
                station.providerName = provider.name;
                station.providerEvidence = provider.evidence;
            }
            station.addQuote(quote);
        }
        return output;
    }

    private static FuelStationRecord parseCard(
            OcrRow title,
            List<OcrRow> card,
            String globalGrade,
            String platform,
            String sourceStage
    ) {
        Map<String, FuelOffer> offers = new LinkedHashMap<>();
        String activeGrade = globalGrade;
        for (int index = 0; index < card.size(); index++) {
            OcrRow row = card.get(index);
            String text = clean(row.text);
            String grade = grade(text);
            if (!grade.isEmpty()) activeGrade = grade;
            PriceKind inlineKind = kind(text);
            if (inlineKind == PriceKind.BLOCKED || blocked(text)) continue;
            List<BigDecimal> values = prices(text);
            for (BigDecimal value : values) {
                PriceKind resolved = inlineKind;
                PriceKind nearby = nearbyKind(card, index);
                if (resolved == PriceKind.NONE || resolved == PriceKind.UNCLASSIFIED && nearby != PriceKind.NONE) {
                    resolved = nearby;
                }
                if (resolved == PriceKind.NONE || resolved == PriceKind.BLOCKED) continue;
                String gradeValue = !grade.isEmpty() ? grade : activeGrade;
                if (gradeValue.isEmpty()) continue;
                FuelOffer offer = offers.computeIfAbsent(gradeValue, FuelStationParser::offer);
                apply(offer, resolved, value, row);
            }
        }
        List<FuelOffer> valid = new ArrayList<>();
        for (FuelOffer offer : offers.values()) if (offer.valid()) valid.add(offer);
        if (valid.isEmpty()) return null;
        FuelStationRecord station = emptyStation(title, platform, sourceStage);
        station.address = address(card, station.stationName);
        // 燃油侧无枪数据：不解析加油枪可用数。
        station.fuelOffers.addAll(valid);
        return station;
    }

    private static String address(List<OcrRow> card, String stationName) {
        for (OcrRow row : card) {
            String text = clean(row.text);
            if (text.equals(stationName) || text.length() < 5 || text.length() > 1024) continue;
            if (blocked(text) || grade(text).length() > 0 || kind(text) != PriceKind.NONE) continue;
            if (text.matches(".*(?:省|市|区|县|镇|乡|路|街|道|号|栋|楼|大厦|广场|园区|停车场|加油站).*")) {
                return StationObservationV3.sanitizeAddress(
                        text.replaceAll("[·•．]?\\s*\\d+(?:\\.\\d+)?\\s*(?:米|m|km|公里)$", "")
                );
            }
        }
        return null;
    }

    private static void apply(FuelOffer offer, PriceKind kind, BigDecimal value, OcrRow row) {
        if (!FuelOffer.validRolePrice(value)) return;
        double legacyValue = value.doubleValue();
        if (kind == PriceKind.LIST) offer.listPrice = choose(offer.listPrice, legacyValue);
        else if (kind == PriceKind.DISCOUNT) {
            offer.discountPrice = choose(offer.discountPrice, legacyValue);
            offer.discountKind = "explicit";
        } else if (kind == PriceKind.UNCLASSIFIED) {
            offer.unclassifiedPrice = choose(offer.unclassifiedPrice, legacyValue);
        } else if (kind == PriceKind.DISPLAY) {
            offer.displayPrice = choose(offer.displayPrice, value);
            put(offer.fieldSource, "displayPrice", "ocr");
            offer.discountPrice = choose(offer.discountPrice, legacyValue);
            offer.discountKind = "explicit";
        } else if (kind == PriceKind.STATION) {
            offer.stationPrice = choose(offer.stationPrice, value);
            put(offer.fieldSource, "stationPrice", "ocr");
            offer.listPrice = choose(offer.listPrice, legacyValue);
        } else if (kind == PriceKind.NATIONAL) {
            offer.nationalPrice = choose(offer.nationalPrice, value);
            put(offer.fieldSource, "nationalPrice", "ocr");
            offer.listPrice = choose(offer.listPrice, legacyValue);
        }
        JSONObject evidence = new JSONObject();
        put(evidence, "kind", kind.value);
        put(evidence, "boundingBox", new JSONObject());
        JSONObject box = evidence.optJSONObject("boundingBox");
        put(box, "x", row.x);
        put(box, "y", row.y);
        put(box, "width", row.width);
        put(box, "height", row.height);
        offer.evidence.put(evidence);
    }

    private static PriceKind nearbyKind(List<OcrRow> card, int priceIndex) {
        OcrRow price = card.get(priceIndex);
        PriceKind candidate = PriceKind.NONE;
        float best = Float.MAX_VALUE;
        for (int index = 0; index < card.size(); index++) {
            if (index == priceIndex) continue;
            OcrRow label = card.get(index);
            PriceKind kind = kind(clean(label.text));
            if (kind != PriceKind.LIST
                    && kind != PriceKind.DISCOUNT
                    && kind != PriceKind.DISPLAY
                    && kind != PriceKind.STATION
                    && kind != PriceKind.NATIONAL) {
                continue;
            }
            float yDistance = Math.abs(label.y - price.y);
            float xDistance = Math.abs(label.x - price.x);
            if (yDistance > 0.045f && !(label.y < price.y && price.y - label.y <= 0.075f)) continue;
            float distance = yDistance * 3f + xDistance;
            if (distance < best) {
                best = distance;
                candidate = kind;
            }
        }
        return candidate;
    }

    private static PriceKind kind(String text) {
        if (blocked(text)) return PriceKind.BLOCKED;
        if (text.contains("油站价")) return PriceKind.STATION;
        if (text.contains("国标价")) return PriceKind.NATIONAL;
        if (text.contains("外显价") || text.contains("团油价")
                || text.contains("高德价") || text.contains("加油价")) {
            return PriceKind.DISPLAY;
        }
        if (text.contains("挂牌价")) return PriceKind.LIST;
        if (text.contains("优惠价") || text.contains("折后价")) {
            return PriceKind.DISCOUNT;
        }
        if ((text.contains("元/L") || text.contains("元/升"))
                && !text.matches(".*(?:油站价|国标价|挂牌价|外显价|团油价|高德价|加油价|优惠价|折后价).*")) {
            return PriceKind.UNCLASSIFIED;
        }
        return PriceKind.NONE;
    }

    private static boolean blocked(String text) {
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
                || DISTANCE.matcher(value).find()
                || TIME.matcher(value).find();
    }

    private static List<BigDecimal> prices(String text) {
        List<BigDecimal> output = new ArrayList<>();
        Matcher matcher = PRICE.matcher(text);
        while (matcher.find()) {
            String token = matcher.group(1).replace(',', '.');
            try {
                BigDecimal decimal = new BigDecimal(token).stripTrailingZeros();
                if (decimal.scale() <= 4 && FuelOffer.validRolePrice(decimal)) output.add(decimal);
            } catch (NumberFormatException ignored) {
                // Malformed OCR candidate is ignored.
            }
        }
        return output;
    }

    private static List<OcrRow> titles(List<OcrRow> rows) {
        List<OcrRow> output = new ArrayList<>();
        for (OcrRow row : rows) {
            String value = cleanStationName(row.text);
            if (value.length() < 5 || value.length() > 48) continue;
            if (blocked(value) || !value.matches(".*[\\u4e00-\\u9fa5].*")) continue;
            if (kind(value) != PriceKind.NONE || value.matches(".*\\d+(?:[.,]\\d+)?\\s*(?:元|/L|/升).*")) {
                continue;
            }
            if (value.contains("加油站") || value.contains("油站") || value.contains("石油")
                    || value.contains("石化") || value.contains("能源") && value.endsWith("站")) {
                output.add(row);
            }
        }
        return output;
    }

    private static List<OcrRow> card(List<OcrRow> rows, OcrRow title, float bottom) {
        List<OcrRow> output = new ArrayList<>();
        for (OcrRow row : rows) {
            if (row.y + row.height < title.y - 0.006f || row.y > bottom) continue;
            if (sameColumn(row, title)) output.add(row);
        }
        return output;
    }

    private static OcrRow nextTitleInColumn(List<OcrRow> titles, OcrRow title) {
        OcrRow next = null;
        for (OcrRow candidate : titles) {
            if (candidate == title || candidate.y <= title.y + 0.01f) continue;
            if (!sameColumn(candidate, title)) continue;
            if (next == null || candidate.y < next.y) next = candidate;
        }
        return next;
    }

    private static boolean sameColumn(OcrRow row, OcrRow title) {
        if (row == title) return true;
        float radius = Math.max(0.24f, Math.min(0.34f, (row.width + title.width) * 0.65f));
        return Math.abs(center(row) - center(title)) <= radius;
    }

    private static String globalGrade(List<OcrRow> rows) {
        for (OcrRow row : rows) {
            String text = clean(row.text);
            if (text.contains("筛选")) {
                String grade = grade(text);
                if (!grade.isEmpty()) return grade;
            }
        }
        return "";
    }

    private static String grade(String text) {
        Matcher matcher = GRADE.matcher(clean(text));
        return matcher.find() ? matcher.group(1) + "#" : "";
    }

    private static FuelOffer offer(String grade) {
        FuelOffer offer = new FuelOffer();
        offer.gradeCode = grade.replace("#", "");
        offer.gradeLabel = grade;
        offer.fuelType = "0#".equals(grade) || "-10#".equals(grade) ? "diesel" : "gasoline";
        return offer;
    }

    private static Double choose(Double current, double incoming) {
        return current == null ? incoming : current;
    }

    private static int integer(String value) {
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    private static BigDecimal choose(BigDecimal current, BigDecimal incoming) {
        return current == null ? incoming : current;
    }

    private static FuelStationRecord emptyStation(
            OcrRow title,
            String platform,
            String sourceStage
    ) {
        FuelStationRecord station = new FuelStationRecord();
        station.platform = platform;
        station.stationName = cleanStationName(title.text);
        station.address = null;
        station.sourceStage = sourceStage == null ? "screen-ocr-manual-scroll" : sourceStage;
        if ("tuanyou".equals(platform)) station.localParser = "tuanyou-android-ocr";
        else if ("amap-fuel".equals(platform)) station.localParser = "amap-fuel-android-ocr";
        else station.localParser = "generic-fuel-android-ocr";
        station.captureContextId = DeviceIdentity.sha256(
                platform + "|" + station.stationName + "|" + Math.round(title.x * 100)
        ).substring(0, 12);
        return station;
    }

    private static Provider provider(List<OcrRow> rows) {
        for (OcrRow row : rows) {
            String text = clean(row.text);
            Matcher quoted = PROVIDED_BY_QUOTED.matcher(text);
            Matcher explicit = PROVIDER.matcher(text);
            Matcher by = PROVIDED_BY.matcher(text);
            String name = quoted.find() ? quoted.group(1)
                    : explicit.find() ? explicit.group(1)
                    : by.find() ? by.group(1) : "";
            name = cleanProvider(name);
            if (name.isEmpty() || "高德".equals(name) || "高德地图".equals(name)) continue;
            JSONObject evidence = new JSONObject();
            put(evidence, "kind", "provider-attribution");
            put(evidence, "text", name);
            JSONObject box = new JSONObject();
            put(box, "x", row.x);
            put(box, "y", row.y);
            put(box, "width", row.width);
            put(box, "height", row.height);
            put(evidence, "boundingBox", box);
            return new Provider(name, evidence);
        }
        return null;
    }

    private static FuelQuote quote(List<OcrRow> rows) {
        BigDecimal selected = labeledMoney(
                rows,
                new String[]{"加油金额", "订单金额", "选择金额", "本次金额"},
                new String[]{"优惠金额", "实付金额"}
        );
        BigDecimal gross = labeledMoney(
                rows,
                new String[]{"优惠金额", "总优惠", "已优惠", "油品优惠"},
                new String[]{"优惠价"}
        );
        BigDecimal service = labeledMoney(
                rows,
                new String[]{"服务费"},
                new String[0]
        );
        BigDecimal payable = labeledMoney(
                rows,
                new String[]{"预计实付", "实付金额", "应付金额"},
                new String[0]
        );
        if (selected == null || (gross == null && service == null && payable == null)) return null;

        String grade = "";
        String gradeLabel = "";
        String gunCode = "";
        String gunLabel = "";
        boolean popup = isExplanationPopup(rows);
        for (OcrRow row : rows) {
            String text = clean(row.text);
            if (grade.isEmpty()) {
                Matcher gradeMatcher = GRADE.matcher(text);
                if (gradeMatcher.find()) {
                    grade = gradeMatcher.group(1);
                    gradeLabel = gradeMatcher.group();
                }
            }
            if (gunCode.isEmpty()) {
                Matcher gunMatcher = GUN.matcher(text);
                if (gunMatcher.find()) {
                    gunCode = gunMatcher.group(1);
                    gunLabel = gunMatcher.group();
                }
            }
        }
        if (grade.isEmpty()) return null;
        FuelQuote quote = new FuelQuote();
        quote.gradeCode = grade;
        quote.gradeLabel = gradeLabel.isEmpty() ? grade + "#" : gradeLabel;
        quote.gunCode = gunCode.isEmpty() ? null : gunCode;
        quote.gunLabel = gunLabel.isEmpty() ? null : gunLabel;
        quote.selectedAmount = selected;
        quote.grossDiscount = gross;
        quote.serviceFee = service;
        quote.payableAmount = payable;
        quote.quoteEntry = popup ? "explanation_popup" : "inline";
        quote.validateFormula();
        return quote.valid() ? quote : null;
    }

    private static boolean isExplanationPopup(List<OcrRow> rows) {
        boolean title = false;
        boolean popupStructure = false;
        int breakdownRows = 0;
        for (OcrRow row : rows) {
            String text = clean(row.text);
            if (text.matches("^(?:优惠说明|费用说明|优惠详情|费用详情)$")) title = true;
            if (text.contains("关闭") || text.contains("知道了")
                    || text.contains("优惠明细") || text.contains("费用明细")) {
                popupStructure = true;
            }
            if (text.contains("优惠金额") || text.contains("服务费")
                    || text.contains("预计实付") || text.contains("应付金额")) {
                breakdownRows++;
            }
        }
        return title && (popupStructure || breakdownRows >= 2);
    }

    private static BigDecimal labeledMoney(
            List<OcrRow> rows,
            String[] labels,
            String[] excludedLabels
    ) {
        for (int index = 0; index < rows.size(); index++) {
            OcrRow row = rows.get(index);
            String text = clean(row.text);
            if (!containsAny(text, labels) || containsAny(text, excludedLabels)) continue;
            BigDecimal direct = firstMoney(text);
            if (direct != null) return direct;
            BigDecimal nearby = nearestMoney(rows, index);
            if (nearby != null) return nearby;
        }
        return null;
    }

    private static BigDecimal nearestMoney(List<OcrRow> rows, int labelIndex) {
        OcrRow label = rows.get(labelIndex);
        BigDecimal candidate = null;
        float best = Float.MAX_VALUE;
        for (int index = 0; index < rows.size(); index++) {
            if (index == labelIndex) continue;
            OcrRow row = rows.get(index);
            String text = clean(row.text);
            if (GRADE.matcher(text).find() || GUN.matcher(text).find()) continue;
            BigDecimal value = firstMoney(text);
            if (value == null) continue;
            float yDistance = Math.abs(row.y - label.y);
            float xDistance = Math.abs(row.x - label.x);
            if (yDistance > 0.05f && !(row.y > label.y && row.y - label.y <= 0.08f)) continue;
            float distance = yDistance * 3f + xDistance;
            if (distance < best) {
                best = distance;
                candidate = value;
            }
        }
        return candidate;
    }

    private static BigDecimal firstMoney(String text) {
        Matcher matcher = MONEY.matcher(text);
        while (matcher.find()) {
            String token = matcher.group(1).replace(',', '.');
            BigDecimal value = FuelQuote.money(token);
            if (value != null && value.signum() >= 0) return value;
        }
        return null;
    }

    private static boolean containsAny(String value, String[] candidates) {
        if (candidates == null) return false;
        for (String candidate : candidates) {
            if (!clean(candidate).isEmpty() && value.contains(candidate)) return true;
        }
        return false;
    }

    private static String cleanProvider(String value) {
        String output = clean(value)
                .replaceAll("(?:手机号|手机号码|联系电话|身份证|银行卡|验证码|短信码|"
                        + "订单(?:号|编号|ID|信息)?|支付(?:号|编号|ID|账户|账号|密码|凭证)|"
                        + "交易号|账号|账户|用户名|登录名|密码|口令).*$", "")
                .replaceAll("^(?:服务商|CP|cp)[:：]?", "")
                .replaceAll("(?:(?:提供)?服务|提供|服务商|CP|cp)$", "")
                .replaceAll("^[：:·•\\-]+|[：:·•\\-]+$", "");
        if (StationSensitiveDataPolicy.isSensitive(output)) return "";
        return output.length() <= 40 ? output : output.substring(0, 40);
    }

    private static float center(OcrRow row) {
        return row.x + row.width / 2f;
    }

    private static String cleanStationName(String value) {
        return clean(value).replaceAll("^[·•\\-]+|[·•\\-]+$", "");
    }

    private static String clean(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }

    private static final class Provider {
        final String name;
        final JSONObject evidence;

        Provider(String name, JSONObject evidence) {
            this.name = name;
            this.evidence = evidence;
        }
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化燃油 OCR 证据", error);
        }
    }

    private enum PriceKind {
        NONE("unknown"),
        LIST("list-price"),
        DISCOUNT("discount-price"),
        DISPLAY("display-price"),
        STATION("station-price"),
        NATIONAL("national-price"),
        UNCLASSIFIED("unclassified-price"),
        BLOCKED("blocked");

        final String value;

        PriceKind(String value) {
            this.value = value;
        }
    }
}
