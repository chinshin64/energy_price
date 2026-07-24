package com.datafordidi.mobilecollector;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Amap (高德地图 com.autonavi.minimap) station parser.
 *
 * Key differences from DidiLocalStationParser:
 * <ul>
 *   <li>Port format: "空X/Y" instead of "闲X/Y"</li>
 *   <li>Multi-line station names (e.g., parenthesized names spanning 2 lines)</li>
 *   <li>Address suffix cleaning: ·驾车N分钟·地下B1·写字楼内 etc.</li>
 *   <li>Amap-specific noise words: 优选电站, 桩多, 卫生间, 高德红包 etc.</li>
 *   <li>Relaxed station keyword matching (amap titles don't always end with 充电站)</li>
 * </ul>
 *
 * Returns {@link DidiLocalStationParser.StationRecord} instances for compatibility
 * with the shared {@code CaptureOcrService} / {@code SyncClient} pipeline.
 */
public final class AmapStationParser {

    private static final Pattern PRICE_PATTERN = Pattern.compile(
            "[¥￥]\\s*(\\d+(?:\\.\\d{1,4})?)\\s*(?:元)?\\s*/?\\s*(?:度|千瓦时|kWh|KWH)?|"
                    + "(?<![\\d.])(\\d+(?:\\.\\d{1,4})?)\\s*(?:元)?\\s*/\\s*(?:度|千瓦时|kWh|KWH)"
    );

    /** Amap uses 空 (empty) instead of Didi's 闲 (idle). */
    private static final Pattern PORT_PATTERN = Pattern.compile(
            "(快|慢|超)?\\s*(?:充|充桩|充电桩|桩)?\\s*(?:空|空闲?)\\s*(\\d+)\\s*/\\s*(\\d+)"
    );

    private static final Pattern ADDRESS_SUFFIX_PATTERN = Pattern.compile(
            "[·•．]驾车\\d+分钟|[·•．]步行\\d+分钟|[·•．].*?分钟|[·•．]地下[\\w\\d]*|[·•．]写字楼[内]?|[·•．]商场[内]?|[·•．]地面"
    );

    private AmapStationParser() {
    }

    // ── Public API ──────────────────────────────────────────────────────

    public static List<DidiLocalStationParser.StationRecord> extract(
            List<OcrRow> inputRows, String sourceStage
    ) {
        if (inputRows == null || inputRows.isEmpty()) {
            return new ArrayList<>();
        }

        List<OcrRow> rows = new ArrayList<>(inputRows);
        rows.sort(Comparator.comparingDouble((OcrRow row) -> row.y).thenComparingDouble(row -> row.x));

        List<OcrRow> titles = findTitles(rows);
        Map<String, DidiLocalStationParser.StationRecord> deduped = new LinkedHashMap<>();
        for (int i = 0; i < titles.size(); i++) {
            OcrRow title = titles.get(i);
            OcrRow nextTitle = findNextTitleInColumn(titles, i, title);
            List<OcrRow> band = stationBand(rows, title, nextTitle);
            DidiLocalStationParser.StationRecord station = parseBand(title, band, sourceStage);
            if (station != null) {
                deduped.put(station.stationName + "|" + nullToEmpty(station.address), station);
            }
        }
        return new ArrayList<>(deduped.values());
    }

    // ── Title detection ─────────────────────────────────────────────────

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
        return isPossibleStationName(text) && hasStationKeyword(text);
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
        return hasChargeCategorySignal(bandText)
                && (hasEnergyPrice(bandText) || hasPortSignal(bandText));
    }

    // ── Band extraction ─────────────────────────────────────────────────

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
            if (candidate.y <= title.y + 0.012f || !isSameColumn(title, candidate)) {
                continue;
            }
            return candidate;
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

    // ── Band parsing ────────────────────────────────────────────────────

    private static DidiLocalStationParser.StationRecord parseBand(
            OcrRow title, List<OcrRow> band, String sourceStage
    ) {
        String stationName = mergeTitleLines(title, band);
        if (!isPossibleStationName(stationName)) {
            return null;
        }
        if (!isDetailStage(sourceStage) && isTruncated(stationName)) {
            return null;
        }

        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.platform = "amap-charging";
        station.localParser = "amap-android";
        station.stationName = stationName;
        station.address = extractAddress(band, stationName);
        station.sourceStage = sourceStage == null ? "phone-auto-scroll" : sourceStage;

        for (OcrRow row : band) {
            String rowText = compact(row.text);
            parsePorts(station, rowText);
            parsePrice(station, rowText);
        }
        // Amap may render the currency symbol, amount and unit as separate OCR rows.
        parsePrice(station, join(band));
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

    /**
     * Merge multi-line amap station names.
     * Example: "小桔充电汽车充电站(BP快速充电站" + "杭州余杭未来新湖中心)"
     * → "小桔充电汽车充电站(BP快速充电站杭州余杭未来新湖中心)"
     */
    private static String mergeTitleLines(OcrRow title, List<OcrRow> band) {
        String name = normalizeStationCandidate(title.text);
        if (!needsLineMerge(name)) {
            return name;
        }
        for (OcrRow row : band) {
            if (row == title) continue;
            if (row.y <= title.y) continue;
            if (row.y > title.y + 0.04f) break;
            String nextLine = normalizeStationCandidate(row.text);
            if (nextLine.isEmpty()) continue;
            if (hasEnergyPrice(nextLine) || hasPortSignal(nextLine) || isNoise(nextLine)) continue;
            String merged = name + nextLine;
            if (merged.length() > 48) break;
            return merged;
        }
        return name;
    }

    private static boolean needsLineMerge(String text) {
        int open = countChar(text, '（') + countChar(text, '(');
        int close = countChar(text, '）') + countChar(text, ')');
        return open > close;
    }

    private static int countChar(String text, char ch) {
        int n = 0;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == ch) n++;
        }
        return n;
    }

    // ── Port parsing (amap: 空 not 闲) ────────────────────────────────

    private static void parsePorts(DidiLocalStationParser.StationRecord station, String text) {
        Matcher matcher = PORT_PATTERN.matcher(text);
        while (matcher.find()) {
            String type = matcher.group(1);
            int idle = parseInt(matcher.group(2));
            int total = parseInt(matcher.group(3));
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

    // ── Price parsing ───────────────────────────────────────────────────

    private static void parsePrice(DidiLocalStationParser.StationRecord station, String text) {
        Matcher matcher = PRICE_PATTERN.matcher(text);
        while (matcher.find()) {
            String before = text.substring(Math.max(0, matcher.start() - 16), matcher.start());
            String after = text.substring(matcher.end(), Math.min(text.length(), matcher.end() + 16));
            String context = before + after;
            if (context.contains("超时") || context.contains("占用费") || context.contains("分钟")
                    || context.contains("停车") || context.contains("服务费") || context.contains("优惠")) {
                continue;
            }
            String priceText = matcher.group(1) != null ? matcher.group(1) : matcher.group(2);
            double price = parseDouble(priceText);
            if (price < 0.2d || price > 3.5d) {
                continue;
            }
            if (context.contains("超") || (station.superTotalPorts > 0 && station.fastTotalPorts == 0)) {
                station.priceSuper = firstPrice(station.priceSuper, price);
            } else if (context.contains("慢")) {
                station.priceSlow = firstPrice(station.priceSlow, price);
            } else {
                station.priceFast = firstPrice(station.priceFast, price);
            }
            return;
        }
    }

    // ── Address extraction (amap: clean ·suffixes) ─────────────────────

    private static String extractAddress(List<OcrRow> band, String stationName) {
        for (OcrRow row : band) {
            String text = compact(row.text);
            if (text.equals(stationName) || !isAddressLike(text)) {
                continue;
            }
            return cleanAmapAddress(text);
        }
        return null;
    }

    private static String cleanAmapAddress(String text) {
        String cleaned = ADDRESS_SUFFIX_PATTERN.matcher(text).replaceAll("")
                .replaceAll("[·•．]?\\s*\\d+(?:\\.\\d+)?\\s*(?:米|m|km|公里)$", "")
                .trim();
        if (cleaned.isEmpty() && text.length() > 0) {
            return text; // avoid returning empty after all suffixes removed
        }
        return cleaned;
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

    // ── Validation helpers ──────────────────────────────────────────────

    private static boolean isPossibleStationName(String text) {
        String value = normalizeStationCandidate(text);
        if (value.length() < 5 || value.length() > 48 || !value.matches(".*[\\u4e00-\\u9fa5].*")) {
            return false;
        }
        if (isNoise(value) || hasEnergyPrice(value) || hasPortSignal(value) || value.matches("^[¥￥]?\\d.*")) {
            return false;
        }
        if (value.contains("券")
                || value.contains("余额") || value.contains("余額")
                || value.contains("余颌") || value.contains("余领")
                || value.contains("可用充电") || value.contains("场站专属")
                || value.contains("场站优惠") || value.contains("停车减免")
                || value.contains("即插即充") || value.contains("即播即充")
                || value.contains("场站已暂停服务") || value.contains("暂停服务")
                || value.contains("暂停营业") || value.contains("已暂停")
                || value.contains("顺风") || value.contains("首单")
                || value.contains("补贴") || value.contains("车辆信息")) {
            return false;
        }
        if (value.matches(".*[A-Za-z][!ル刀口巴用分亡]{2,}.*")) {
            return false;
        }
        return !value.matches("^(地上|地下|快充|慢充|超充|私家车常充|电池防护|服务费8折券|场站优惠|7天内未跳枪)$");
    }

    private static boolean isNoise(String text) {
        return text.contains("搜索")
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
                // ── Amap-specific noise ──
                || text.contains("优选电站")
                || text.contains("桩多")
                || text.contains("卫生间")
                || text.contains("充电桩二维码")
                || text.contains("分钟内有人充电")
                || text.contains("分钟前有人购买")
                || text.contains("停车费")
                || text.contains("限免")
                || text.contains("高德红包")
                || (text.contains("满") && text.contains("减") && text.length() <= 6)
                || text.matches(".*\\d+(\\.\\d+)?(km|公里|m)$");
    }

    private static boolean hasStationKeyword(String text) {
        // Amap-relaxed: accept "充电" or "电站" alone, not just "充电站"
        return text.contains("充电站")
                || text.contains("超充站")
                || text.contains("快充站")
                || text.contains("极充站")
                || text.contains("充电中心")
                || text.contains("充电广场")
                || text.contains("充电桩")
                || text.contains("小桔充电")
                || text.contains("充电")
                || text.contains("电站")
                || text.matches(".*(超快充|超级充电|智能充电|来充电|蔚来超充|小鹏超充|小鹏S4超快充|bp\\s*pulse快充|bppulse快充).*(站|中心|广场|大厦|车库).*");
    }

    private static boolean hasEnergyPrice(String text) {
        return text.matches(".*[¥￥]\\s*\\d+(\\.\\d+)?\\s*/?\\s*(度|kWh|KWH)?.*")
                || text.matches(".*\\d+(\\.\\d+)?\\s*元\\s*/?\\s*(度|kWh|KWH).*");
    }

    private static boolean hasPortSignal(String text) {
        // Amap uses 空
        return text.matches(".*(超|快|慢)?\\s*(空|空闲?)\\s*\\d+\\s*/\\s*\\d+.*");
    }

    private static boolean hasChargeCategorySignal(String text) {
        return text.matches(".*(充电站|充电桩|快充桩|慢充桩|超充桩|充电中心|充电广场).*?");
    }

    private static boolean isDetailStage(String sourceStage) {
        return sourceStage != null && sourceStage.contains("detail");
    }

    private static boolean isTruncated(String text) {
        return text.contains("...") || text.contains("…");
    }

    // ── Text utilities ──────────────────────────────────────────────────

    private static String normalizeStationCandidate(String text) {
        return compact(text)
                .replaceAll("^[^\\u4e00-\\u9fa5]+", "")
                .replaceAll("^(晚上|晚止)\\d{1,2}[:：]?\\d{0,2}[|丨]?[\\d\\.Kk/sgS]*", "");
    }

    private static String join(List<OcrRow> rows) {
        StringBuilder sb = new StringBuilder();
        for (OcrRow row : rows) {
            sb.append(compact(row.text)).append(' ');
        }
        return sb.toString();
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
}
