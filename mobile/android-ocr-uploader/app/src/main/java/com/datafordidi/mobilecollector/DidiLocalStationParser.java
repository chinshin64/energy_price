package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class DidiLocalStationParser {
    private static final Pattern PORT_PATTERN = Pattern.compile("(超|快|慢)?\\s*(?:充)?\\s*(?:闲|空闲)\\s*(\\d+)\\s*/\\s*(\\d+)");
    private static final Pattern SERVICE_PRICE_PATTERN = Pattern.compile(
            "(?:服务费|服务价格)\\s*[:：]?\\s*[¥￥]?\\s*(\\d+(?:[.,]\\d{1,4})?)"
    );
    private static final Set<String> REJECTION_REASON_ALLOWLIST = new HashSet<>(Arrays.asList(
            "price-candidate-rejected",
            "no-price-candidate",
            "port-candidate-rejected",
            "no-port-candidate"
    ));

    private DidiLocalStationParser() {
    }

    public static List<StationRecord> extract(List<OcrRow> inputRows, String sourceStage) {
        if (inputRows == null || inputRows.isEmpty()) {
            return new ArrayList<>();
        }

        List<OcrRow> rows = new ArrayList<>(inputRows);
        rows.sort(Comparator.comparingDouble((OcrRow row) -> row.y).thenComparingDouble(row -> row.x));

        List<OcrRow> titles = findTitles(rows);
        Map<String, StationRecord> deduped = new LinkedHashMap<>();
        for (int i = 0; i < titles.size(); i += 1) {
            OcrRow title = titles.get(i);
            OcrRow nextTitle = findNextTitleInColumn(titles, i, title);
            List<OcrRow> band = stationBand(rows, title, nextTitle);
            StationRecord station = parseBand(title, band, sourceStage);
            if (station != null) {
                String key = compact(station.stationName) + "|" + station.transientCardKey;
                deduped.put(key, StationRecordMerger.merge(deduped.get(key), station));
            }
        }
        return new ArrayList<>(deduped.values());
    }

    private static List<OcrRow> findTitles(List<OcrRow> rows) {
        List<OcrRow> titles = new ArrayList<>();
        for (OcrRow row : rows) {
            String text = compact(row.text);
            if (isExplicitStationTitle(text) || isContextualStationTitle(row, rows)) {
                titles.add(row);
            }
        }
        return titles;
    }

    private static boolean isExplicitStationTitle(String text) {
        if (!isPossibleStationName(text)) {
            return false;
        }
        return hasStationKeyword(text);
    }

    private static boolean isContextualStationTitle(OcrRow row, List<OcrRow> rows) {
        String text = compact(row.text);
        if (!isPossibleStationName(text) || row.y < 0.18f || row.x > 0.72f) {
            return false;
        }

        StringBuilder band = new StringBuilder();
        for (OcrRow item : rows) {
            if (item == row) {
                continue;
            }
            if (item.y > row.y && item.y < row.y + 0.18f && isSameColumn(row, item)) {
                band.append(compact(item.text)).append(' ');
            }
        }
        String bandText = band.toString();
        return hasStationKeyword(text) && (hasEnergyPrice(bandText) || hasPortSignal(bandText));
    }

    private static List<OcrRow> stationBand(List<OcrRow> rows, OcrRow title, OcrRow nextTitle) {
        List<OcrRow> band = new ArrayList<>();
        float maxY = title.y + Math.max(0.22f, title.height * 8f);
        if (nextTitle != null) {
            maxY = Math.min(maxY, nextTitle.y - 0.006f);
        }
        for (OcrRow row : rows) {
            if (row == title || (row.y > title.y && row.y < maxY && isSameColumn(title, row))) {
                band.add(row);
            }
        }
        band.sort(Comparator.comparingDouble((OcrRow row) -> row.y).thenComparingDouble(row -> row.x));
        return band;
    }

    private static OcrRow findNextTitleInColumn(List<OcrRow> titles, int currentIndex, OcrRow title) {
        for (int index = currentIndex + 1; index < titles.size(); index++) {
            OcrRow candidate = titles.get(index);
            if (candidate.y > title.y + 0.012f && isSameColumn(title, candidate)) return candidate;
        }
        return null;
    }

    private static boolean isSameColumn(OcrRow title, OcrRow row) {
        float titleCenter = title.x + title.width / 2f;
        float rowCenter = row.x + row.width / 2f;
        boolean titleIsGridCard = title.width > 0f && title.width < 0.58f;
        boolean rowIsFullWidth = row.width >= 0.72f;
        if (titleIsGridCard && !rowIsFullWidth) {
            return (titleCenter < 0.5f) == (rowCenter < 0.5f);
        }
        return Math.abs(titleCenter - rowCenter) <= 0.36f;
    }

    private static StationRecord parseBand(OcrRow title, List<OcrRow> band, String sourceStage) {
        String stationName = cleanStationName(title.text);
        if (!isPossibleStationName(stationName)) {
            return null;
        }
        if (!isDetailStage(sourceStage) && isTruncated(stationName)) {
            return null;
        }

        StationRecord station = new StationRecord();
        station.platform = "didi-charging";
        station.localParser = "didi-android";
        station.stationName = stationName;
        CardIdentityPolicy.attachTransientIdentity(
                station,
                title,
                extractAddress(band, stationName)
        );
        station.sourceStage = sourceStage == null ? "phone-auto-scroll" : sourceStage;
        station.bandRowCount = band.size();

        for (OcrRow row : band) {
            String rowText = compact(row.text);
            station.priceCandidateCount += EnergyPriceParser.rawCandidateCount(rowText);
            station.portCandidateCount += PortSignalParser.candidateCount(rowText);
            parsePorts(station, rowText);
            parseServicePrice(station, rowText);
            parsePrice(station, rowText, row);
        }
        parseCombinedPrice(station, band);
        if (!isDetailStage(sourceStage)
                && station.priceFast == null
                && station.priceSlow == null
                && station.priceSuper == null
                && station.fastTotalPorts == 0
                && station.slowTotalPorts == 0
                && station.superTotalPorts == 0) {
            return null;
        }
        station.rawOcrRows = rowsToJson(band);
        return station;
    }

    private static void parsePorts(StationRecord station, String text) {
        Matcher matcher = PORT_PATTERN.matcher(text);
        while (matcher.find()) {
            String type = matcher.group(1);
            int idle = parseInt(matcher.group(2));
            int total = parseInt(matcher.group(3));
            if (total < idle || total > 10000) continue;
            station.portsObserved = true;
            if ("超".equals(type) || (type == null && text.contains("超"))) {
                station.superIdlePorts = Math.max(station.superIdlePorts, idle);
                station.superTotalPorts = Math.max(station.superTotalPorts, total);
            } else if ("慢".equals(type)) {
                station.slowIdlePorts = Math.max(station.slowIdlePorts, idle);
                station.slowTotalPorts = Math.max(station.slowTotalPorts, total);
            } else {
                station.fastIdlePorts = Math.max(station.fastIdlePorts, idle);
                station.fastTotalPorts = Math.max(station.fastTotalPorts, total);
            }
        }
    }

    private static void parsePrice(StationRecord station, String text, OcrRow evidenceRow) {
        EnergyPriceParser.Match match = EnergyPriceParser.first(text);
        if (match == null) return;
        station.priceObserved = true;
        if ("super".equals(match.type) || station.superTotalPorts > 0 && station.fastTotalPorts == 0) {
            station.priceSuper = firstPrice(station.priceSuper, match.value);
        } else if ("slow".equals(match.type)) {
            station.priceSlow = firstPrice(station.priceSlow, match.value);
        } else {
            station.priceFast = firstPrice(station.priceFast, match.value);
        }
        PriceEvidence.add(station, match, evidenceRow);
    }

    private static void parseServicePrice(StationRecord station, String text) {
        Matcher matcher = SERVICE_PRICE_PATTERN.matcher(text);
        if (!matcher.find()) return;
        double value = parseDouble(matcher.group(1).replace(',', '.'));
        if (value < 0d || value > 3.5d) return;
        station.priceService = firstPrice(station.priceService, value);
        station.priceObserved = true;
    }

    private static void parseCombinedPrice(StationRecord station, List<OcrRow> band) {
        if (station.priceObserved || band == null || band.isEmpty()) return;
        StringBuilder text = new StringBuilder();
        for (OcrRow row : band) text.append(compact(row.text));
        parsePrice(station, text.toString(), PriceEvidence.union(band, 0, band.size(), text.toString()));
    }

    private static String extractAddress(List<OcrRow> band, String stationName) {
        for (OcrRow row : band) {
            String text = compact(row.text);
            if (text.equals(stationName) || !isAddressLike(text)) {
                continue;
            }
            return text;
        }
        return null;
    }

    private static boolean isAddressLike(String text) {
        if (text.length() < 6 || text.length() > 90) {
            return false;
        }
        if (hasEnergyPrice(text) || hasPortSignal(text) || isNoise(text)) {
            return false;
        }
        return text.matches(".*(省|市|区|县|镇|路|街|道|号|栋|楼|大厦|广场|园区|停车场|地下).*");
    }

    private static boolean isPossibleStationName(String text) {
        String value = normalizeStationCandidate(text);
        if (value.length() < 5 || value.length() > 42 || !value.matches(".*[\\u4e00-\\u9fa5].*")) {
            return false;
        }
        if (isNoise(value) || hasEnergyPrice(value) || hasPortSignal(value) || value.matches("^[¥￥]?\\d.*")) {
            return false;
        }
        if (value.contains("券")
                || value.contains("余额")
                || value.contains("余額")
                || value.contains("余颌")
                || value.contains("余领")
                || value.contains("可用充电")
                || value.contains("场站专属")
                || value.contains("场站优惠")
                || value.contains("停车减免")
                || value.contains("即插即充")
                || value.contains("即播即充")
                || value.contains("场站已暂停服务")
                || value.contains("暂停服务")
                || value.contains("暂停营业")
                || value.contains("已暂停")
                || value.contains("顺风")
                || value.contains("首单")
                || value.contains("补贴")
                || value.contains("车辆信息")) {
            return false;
        }
        if (value.matches(".*[A-Za-z][!ル刀口巴用分亡]{2,}.*")) {
            return false;
        }
        return !value.matches("^(地上|地下|快充|慢充|超充|私家车常充|电池防护|服务费8折券|场站优惠|7天内未跳枪)$");
    }

    private static boolean isNoise(String text) {
        return text.matches("^(此|该)电站.*(免费停车|停车说明|收费说明).*$")
                || text.contains("充电免停车")
                || text.contains("搜索")
                || text.contains("附近")
                || text.contains("地图")
                || text.contains("小程序")
                || text.contains("APP")
                || text.contains("app")
                || text.contains("筛选")
                || text.contains("广告")
                || text.contains("跳过")
                || text.contains("登录")
                || text.contains("首页")
                || text.contains("我的")
                || text.contains("您有")
                || text.contains("信息待完善")
                || text.contains("充电余额")
                || text.contains("可用充电")
                || text.contains("余领")
                || text.contains("余颌")
                || text.contains("免费充电")
                || text.contains("免费领租车")
                || text.contains("去收下")
                || text.contains("交易保障")
                || text.contains("充电订单")
                || text.contains("充电会员")
                || text.contains("滴滴充电")
                || text.contains("扫码充电")
                || text.contains("开始充电")
                || text.contains("补充车辆")
                || text.contains("uname")
                || text.contains("聊天记录")
                || text.contains("网络结果")
                || text.contains("近期最大")
                || text.contains("分钟前有人充过")
                || text.contains("有人充过")
                || text.contains("跳枪")
                || text.contains("跳抢")
                || text.contains("停车减免")
                || text.contains("停车滅免")
                || text.contains("停车威免")
                || text.contains("私家车")
                || text.contains("常充")
                || text.contains("场站已暂停服务")
                || text.contains("暂停服务")
                || text.contains("暂停营业")
                || text.contains("到底了")
                || text.contains("可用券")
                || text.contains("张可用")
                || text.contains("即插")
                || text.contains("即播")
                || text.contains("暂停")
                || text.contains("重启")
                || text.contains("停止")
                || text.contains("小时")
                || text.contains("分钟")
                || text.contains("服务费")
                || text.contains("超时")
                || text.contains("占用费")
                || text.matches(".*\\d+(\\.\\d+)?(km|公里|m)$");
    }

    private static boolean hasStationKeyword(String text) {
        return text.contains("充电站")
                || text.contains("超充站")
                || text.contains("快充站")
                || text.contains("极充站")
                || text.contains("充电中心")
                || text.contains("充电广场")
                || text.contains("充电桩")
                || text.contains("小桔充电")
                || text.matches(".*(超快充|超级充电|智能充电|来充电|蔚来超充|小鹏超充|小鹏S4超快充|bp\\s*pulse快充|bppulse快充).*(站|中心|广场|大厦|车库).*");
    }

    private static boolean hasEnergyPrice(String text) {
        return text.matches(".*[¥￥]\\s*\\d+(\\.\\d+)?\\s*/?\\s*(度|kWh|KWH)?.*")
                || text.matches(".*\\d+(\\.\\d+)?\\s*元\\s*/?\\s*(度|kWh|KWH).*");
    }

    private static boolean hasPortSignal(String text) {
        return text.matches(".*(超|快|慢)?\\s*(闲|空闲)\\s*\\d+\\s*/\\s*\\d+.*");
    }

    private static boolean isDetailStage(String sourceStage) {
        return sourceStage != null && sourceStage.contains("detail");
    }

    private static boolean isTruncated(String text) {
        return text.contains("...") || text.contains("…");
    }

    private static String cleanStationName(String text) {
        return normalizeStationCandidate(text).replaceAll("^[·•。]+", "").replaceAll("[|「」【】]+", "");
    }

    private static String normalizeStationCandidate(String text) {
        return compact(text)
                .replaceAll("^[^\\u4e00-\\u9fa5]+", "")
                .replaceAll("^(晚上|晚止)\\d{1,2}[:：]?\\d{0,2}[|丨]?[\\d\\.Kk/sgS]*", "");
    }

    private static String join(List<OcrRow> rows) {
        StringBuilder builder = new StringBuilder();
        for (OcrRow row : rows) {
            builder.append(compact(row.text)).append(' ');
        }
        return builder.toString();
    }

    private static JSONArray rowsToJson(List<OcrRow> rows) {
        JSONArray array = new JSONArray();
        for (OcrRow row : rows) {
            try {
                array.put(row.toJson());
            } catch (Exception ignored) {
            }
        }
        return array;
    }

    private static String compact(String text) {
        return String.valueOf(text == null ? "" : text).replaceAll("\\s+", "").trim();
    }

    private static int parseInt(String text) {
        try {
            return Integer.parseInt(text);
        } catch (Exception ignored) {
            return 0;
        }
    }

    private static double parseDouble(String text) {
        try {
            return Double.parseDouble(text);
        } catch (Exception ignored) {
            return 0d;
        }
    }

    private static Double firstPrice(Double current, double incoming) {
        return current == null ? incoming : current;
    }

    private static String nullToEmpty(String text) {
        return text == null ? "" : text;
    }

    public static final class StationRecord {
        public String platform = "didi-charging";
        public String localParser = "didi-android";
        public String stationName;
        public String capturedAt;
        public String address;
        public Double priceFast;
        public Double priceSlow;
        public Double priceSuper;
        public Double priceService;
        public int fastIdlePorts;
        public int fastTotalPorts;
        public int slowIdlePorts;
        public int slowTotalPorts;
        public int superIdlePorts;
        public int superTotalPorts;
        public boolean portsObserved;
        public boolean priceObserved;
        public String sourceStage;
        public JSONArray rawOcrRows;
        public JSONArray priceEvidence;
        public int screenRowCount;
        public int bandRowCount;
        public int priceCandidateCount;
        public int portCandidateCount;
        public String captureMode = "unknown";
        public String packageCategory = "unknown";
        public JSONArray rejectionReasons;
        String transientCardKey = "";
        String transientIdentityText = "";
        String transientStaticSignature = "";
        String captureContextId = "";

        public void addRejectionReason(String reason) {
            String value = reason == null ? "" : reason.trim();
            if (!REJECTION_REASON_ALLOWLIST.contains(value)) return;
            if (rejectionReasons == null) rejectionReasons = new JSONArray();
            for (int index = 0; index < rejectionReasons.length(); index++) {
                if (value.equals(rejectionReasons.optString(index))) return;
            }
            if (rejectionReasons.length() < 8) rejectionReasons.put(value);
        }

        public JSONObject toJson() throws Exception {
            int availablePorts = availablePorts();
            int totalPorts = totalPorts();
            boolean observedPorts = portsObserved || fastTotalPorts > 0 || slowTotalPorts > 0 || superTotalPorts > 0;
            boolean observedPrice = priceObserved || priceFast != null || priceSlow != null
                    || priceSuper != null || priceService != null;
            JSONObject raw = rawJson(observedPorts, observedPrice);

            JSONObject json = new JSONObject()
                    .put("schemaVersion", StationObservationV3.SCHEMA_VERSION)
                    .put("stationType", "charging")
                    .put("platform", platform)
                    .put("stationName", stationName)
                    .put("address", address == null ? JSONObject.NULL : address)
                    .put("sourceType", "mobile-ocr")
                    .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                    .put("sourceStage", sourceStage)
                    .put("availablePorts", observedPorts ? availablePorts : JSONObject.NULL)
                    .put("busyPorts", observedPorts ? totalPorts - availablePorts : JSONObject.NULL)
                    .put("totalPorts", observedPorts ? totalPorts : JSONObject.NULL)
                    .put("onlineFastPorts", observedPorts ? fastIdlePorts + superIdlePorts : JSONObject.NULL)
                    .put("onlineSlowPorts", observedPorts ? slowIdlePorts : JSONObject.NULL)
                    .put("fastIdlePorts", observedPorts ? fastIdlePorts : JSONObject.NULL)
                    .put("fastTotalPorts", observedPorts ? fastTotalPorts : JSONObject.NULL)
                    .put("slowIdlePorts", observedPorts ? slowIdlePorts : JSONObject.NULL)
                    .put("slowTotalPorts", observedPorts ? slowTotalPorts : JSONObject.NULL)
                    .put("superIdlePorts", observedPorts ? superIdlePorts : JSONObject.NULL)
                    .put("superTotalPorts", observedPorts ? superTotalPorts : JSONObject.NULL)
                    .put("needsReview", address == null || !observedPorts || !observedPrice)
                    .put("raw", raw);

            JSONArray missingFields = new JSONArray();
            if (address == null) missingFields.put("address");
            if (!observedPorts) missingFields.put("ports");
            if (!observedPrice) missingFields.put("price");
            json.put("missingFields", missingFields);

            if (capturedAt != null && !capturedAt.trim().isEmpty()) {
                json.put("capturedAt", CaptureTime.requireUtc(capturedAt));
            }

            putNullable(json, "priceFast", priceFast);
            putNullable(json, "priceSlow", priceSlow);
            putNullable(json, "priceSuper", priceSuper);
            putNullable(json, "priceService", priceService);
            return json;
        }

        JSONObject rawJson() throws Exception {
            boolean observedPorts = portsObserved || fastTotalPorts > 0 || slowTotalPorts > 0 || superTotalPorts > 0;
            boolean observedPrice = priceObserved || priceFast != null || priceSlow != null
                    || priceSuper != null || priceService != null;
            return rawJson(observedPorts, observedPrice);
        }

        private JSONObject rawJson(boolean observedPorts, boolean observedPrice) throws Exception {
            JSONObject raw = new JSONObject()
                    .put("sourceType", "mobile-ocr")
                    .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                    .put("sourceStage", sourceStage)
                    .put("localParser", localParser)
                    .put("observed", new JSONObject()
                            .put("address", address != null)
                            .put("price", observedPrice)
                            .put("ports", observedPorts)
                            .put("busy", observedPorts));
            String quality = observedPrice || observedPorts ? "dynamic-observed" : "incomplete-name-only";
            JSONObject diagnostics = new JSONObject()
                    .put("screenRowCount", screenRowCount)
                    .put("bandRowCount", bandRowCount)
                    .put("priceCandidateCount", priceCandidateCount)
                    .put("portCandidateCount", portCandidateCount)
                    .put("parser", localParser)
                    .put("mode", captureMode)
                    .put("packageCategory", packageCategory)
                    .put("quality", quality);
            if (rejectionReasons != null && rejectionReasons.length() > 0) {
                JSONArray bounded = new JSONArray();
                for (int index = 0; index < Math.min(8, rejectionReasons.length()); index++) {
                    bounded.put(rejectionReasons.opt(index));
                }
                diagnostics.put("rejectionReasons", bounded);
            }
            raw.put("diagnostics", diagnostics);
            if (priceEvidence != null && priceEvidence.length() > 0) {
                raw.put("priceEvidence", priceEvidence);
            }
            return raw;
        }

        int availablePorts() {
            return fastIdlePorts + slowIdlePorts + superIdlePorts;
        }

        int totalPorts() {
            return fastTotalPorts + slowTotalPorts + superTotalPorts;
        }

        int busyPorts() {
            return Math.max(0, totalPorts() - availablePorts());
        }

        private static void putNullable(JSONObject json, String key, Double value) throws Exception {
            if (value == null) {
                json.put(key, JSONObject.NULL);
            } else {
                json.put(key, value);
            }
        }
    }
}
