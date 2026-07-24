package com.datafordidi.mobilecollector;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class GenericStationParser {
    private static final Pattern PORT_RATIO = Pattern.compile(
            "(超|快|慢)?\\s*(?:充|充电|桩|枪)?\\s*(?:闲|空闲|空|可用)\\s*(\\d+)\\s*/\\s*(\\d+)"
    );
    private static final Pattern PORT_BUSY = Pattern.compile(
            "(超|快|慢)?\\s*(?:充|充电|桩|枪)?[^\\d]{0,4}(?:闲|空闲|空|可用)\\s*(\\d+)[^\\d]{0,5}(?:忙|占用|使用中)\\s*(\\d+)"
    );

    private GenericStationParser() {
    }

    static List<DidiLocalStationParser.StationRecord> extract(
            List<OcrRow> inputRows,
            String platform,
            String sourceStage
    ) {
        if (inputRows == null || inputRows.isEmpty()) return new ArrayList<>();
        List<OcrRow> rows = new ArrayList<>(inputRows);
        rows.sort(Comparator.comparingDouble((OcrRow row) -> row.y).thenComparingDouble(row -> row.x));
        List<OcrRow> titles = new ArrayList<>();
        for (OcrRow row : rows) {
            String text = normalize(row.text);
            if (isStationName(text)) titles.add(row);
        }

        Map<String, DidiLocalStationParser.StationRecord> output = new LinkedHashMap<>();
        for (int index = 0; index < titles.size(); index++) {
            OcrRow title = titles.get(index);
            OcrRow next = nextInColumn(titles, index, title);
            List<OcrRow> band = band(rows, title, next);
            DidiLocalStationParser.StationRecord station = parse(title, band, platform, sourceStage);
            if (station != null) {
                String key = compact(station.stationName) + "|" + station.transientCardKey;
                output.put(key, StationRecordMerger.merge(output.get(key), station));
            }
        }
        return new ArrayList<>(output.values());
    }

    private static DidiLocalStationParser.StationRecord parse(
            OcrRow title,
            List<OcrRow> band,
            String platform,
            String sourceStage
    ) {
        String name = normalize(title.text);
        if (!isStationName(name)) return null;
        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.platform = compact(platform).isEmpty() ? "android-app-unknown" : platform;
        station.localParser = "generic-android";
        station.stationName = name;
        CardIdentityPolicy.attachTransientIdentity(station, title, address(band, name));
        station.sourceStage = sourceStage;
        station.bandRowCount = band.size();
        for (OcrRow row : band) {
            String text = compact(row.text);
            station.priceCandidateCount += EnergyPriceParser.rawCandidateCount(text);
            station.portCandidateCount += PortSignalParser.candidateCount(text);
            parsePorts(station, text);
            parsePrice(station, text, row, title);
        }
        parseAdjacentPorts(station, band);
        parseAdjacentPrices(station, band, title);
        boolean hasAuxiliaryEvidence = station.portsObserved || station.priceObserved;
        if (!station.priceObserved) station.addRejectionReason(
                station.priceCandidateCount > 0 ? "price-candidate-rejected" : "no-price-candidate"
        );
        if (!station.portsObserved) station.addRejectionReason(
                station.portCandidateCount > 0 ? "port-candidate-rejected" : "no-port-candidate"
        );
        if (!hasAuxiliaryEvidence
                && (!hasStrongStationKeyword(name) || !hasProperNamePrefix(name))) return null;
        station.rawOcrRows = rowsToJson(band);
        return station;
    }

    private static void parsePorts(DidiLocalStationParser.StationRecord station, String text) {
        text = PortSignalParser.normalizeStrict(text);
        Matcher ratio = PORT_RATIO.matcher(text);
        while (ratio.find()) {
            setPorts(station, ratio.group(1), integer(ratio.group(2)), integer(ratio.group(3)));
        }
        Matcher busy = PORT_BUSY.matcher(text);
        while (busy.find()) {
            int idle = integer(busy.group(2));
            int occupied = integer(busy.group(3));
            setPorts(station, busy.group(1), idle, idle + occupied);
        }
    }

    private static void setPorts(
            DidiLocalStationParser.StationRecord station,
            String type,
            int idle,
            int total
    ) {
        if (idle < 0 || total < idle || total > 10000) return;
        station.portsObserved = true;
        if ("超".equals(type)) {
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

    private static void parsePrice(
            DidiLocalStationParser.StationRecord station,
            String text,
            OcrRow evidenceRow,
            OcrRow title
    ) {
        EnergyPriceParser.Match match = EnergyPriceParser.first(text);
        if (match == null) match = GeometryPriceRecovery.recover(text, evidenceRow, title);
        if (match == null) return;
        station.priceObserved = true;
        if ("super".equals(match.type)) station.priceSuper = first(station.priceSuper, match.value);
        else if ("slow".equals(match.type)) station.priceSlow = first(station.priceSlow, match.value);
        else station.priceFast = first(station.priceFast, match.value);
        PriceEvidence.add(station, match, evidenceRow);
    }

    private static void parseAdjacentPrices(
            DidiLocalStationParser.StationRecord station,
            List<OcrRow> band,
            OcrRow title
    ) {
        if (station.priceObserved) return;
        for (int start = 0; start < band.size() && !station.priceObserved; start++) {
            StringBuilder combined = new StringBuilder();
            for (int end = start; end < Math.min(band.size(), start + 3); end++) {
                OcrRow row = band.get(end);
                if (end > start && row.y - band.get(end - 1).y > 0.09f) break;
                combined.append(compact(row.text));
                if (end == start) continue;
                String text = combined.toString();
                parsePrice(station, text, PriceEvidence.union(band, start, end + 1, text), title);
                if (station.priceObserved) return;
            }
        }
    }

    private static void parseAdjacentPorts(
            DidiLocalStationParser.StationRecord station,
            List<OcrRow> band
    ) {
        for (int start = 0; start < band.size(); start++) {
            StringBuilder combined = new StringBuilder();
            for (int end = start; end < Math.min(band.size(), start + 3); end++) {
                OcrRow row = band.get(end);
                if (end > start && row.y - band.get(end - 1).y > 0.055f) break;
                combined.append(compact(row.text));
                if (end == start) continue;
                String text = combined.toString();
                if (!PortSignalParser.hasTypedRatio(text)) continue;
                parsePorts(station, text);
            }
        }
    }

    private static String address(List<OcrRow> band, String name) {
        for (OcrRow row : band) {
            String text = compact(row.text);
            if (text.equals(name) || text.length() < 5 || text.length() > 100) continue;
            if (text.matches(".*(省|市|区|县|镇|乡|路|街|道|号|栋|楼|大厦|广场|园区|停车场|车库|地下).*")) {
                return text.replaceAll("[·•．]?\\s*\\d+(?:\\.\\d+)?\\s*(?:米|m|km|公里)$", "");
            }
        }
        return null;
    }

    private static boolean isStationName(String text) {
        if (text.length() < 4 || text.length() > 60 || !text.matches(".*[\\u4e00-\\u9fa5].*")) return false;
        if (!passesUiNoiseGate(text)) return false;
        if (!text.matches(".*(充电站|超充站|快充站|换电站|电站|充电中心|充电广场|充电场站|充电桩群|能源站).*")) return false;
        if (text.matches("^(充电站|超充站|快充站|换电站|电站|充电中心|充电广场|附近充电站|充电场站)$")) return false;
        return !text.matches(".*(搜索|筛选|优惠|红包|订单|余额|导航|排行榜|推荐|扫码|登录|暂停服务|活动).*" );
    }

    private static boolean hasStrongStationKeyword(String text) {
        return text.matches(".*(充电站|超充站|快充站|换电站|充电中心|充电广场|充电场站|充电桩群).*" );
    }

    static boolean hasProperNamePrefix(String text) {
        String value = compact(text);
        int keywordIndex = value.length();
        for (String keyword : Arrays.asList(
                "充电站", "超充站", "快充站", "换电站", "充电中心", "充电广场", "充电场站", "充电桩群"
        )) {
            int candidate = value.indexOf(keyword);
            if (candidate >= 0) keywordIndex = Math.min(keywordIndex, candidate);
        }
        if (keywordIndex == value.length()) return false;
        String prefix = value.substring(0, keywordIndex).replaceAll("[^\\u4e00-\\u9fa5A-Za-z0-9]", "");
        return prefix.codePointCount(0, prefix.length()) >= 2;
    }

    static boolean passesUiNoiseGate(String text) {
        String value = compact(text);
        if (value.isEmpty() || value.matches(".*[/／。！？!?：:；;▼▽▾⌄∨].*")) return false;
        if (value.matches("^(此|该)电站.*(免费停车|停车说明|收费说明).*$")
                || value.contains("充电免停车")) return false;
        return !value.matches(".*(说明|功能|搜索|搜素|列表|查看|模式|基础|目的地|电站名|使用方法|操作指南).*" );
    }

    private static List<OcrRow> band(List<OcrRow> rows, OcrRow title, OcrRow next) {
        List<OcrRow> output = new ArrayList<>();
        float maxY = title.y + Math.max(0.24f, title.height * 9f);
        if (next != null) maxY = Math.min(maxY, next.y - 0.005f);
        for (OcrRow row : rows) {
            if (row == title || (row.y > title.y && row.y < maxY
                    && (sameColumn(title, row) || sameSingleColumnSummaryRow(title, row)))) {
                output.add(row);
            }
        }
        return output;
    }

    private static boolean sameSingleColumnSummaryRow(OcrRow title, OcrRow row) {
        if (title == null || row == null || title.x < 0.16f || title.x > 0.38f) return false;
        float vertical = row.y - title.y;
        if (vertical < 0.07f || vertical > 0.20f) return false;
        String text = compact(row.text);
        boolean leftPrice = row.x < 0.30f && (EnergyPriceParser.rawCandidateCount(text) > 0
                || GeometryPriceRecovery.recover(text, row, title) != null);
        boolean rightPorts = row.x > 0.48f && PortSignalParser.candidateCount(text) > 0;
        return leftPrice || rightPorts;
    }

    private static OcrRow nextInColumn(List<OcrRow> titles, int index, OcrRow title) {
        for (int cursor = index + 1; cursor < titles.size(); cursor++) {
            OcrRow candidate = titles.get(cursor);
            if (candidate.y > title.y + 0.01f && sameColumn(title, candidate)) return candidate;
        }
        return null;
    }

    private static boolean sameColumn(OcrRow left, OcrRow right) {
        float leftCenter = left.x + left.width / 2f;
        float rightCenter = right.x + right.width / 2f;
        if (left.width > 0f && left.width < 0.58f && right.width < 0.72f) {
            return (leftCenter < 0.5f) == (rightCenter < 0.5f);
        }
        return Math.abs(leftCenter - rightCenter) <= 0.48f;
    }

    private static String normalize(String text) {
        return compact(text)
                .replaceAll("^[^\\u4e00-\\u9fa5]+", "")
                .replaceAll("[|「」【】]+", "")
                .replaceAll("[.…]{2,}$", "");
    }

    private static String join(List<OcrRow> rows) {
        StringBuilder output = new StringBuilder();
        for (OcrRow row : rows) output.append(compact(row.text)).append(' ');
        return output.toString();
    }

    private static JSONArray rowsToJson(List<OcrRow> rows) {
        JSONArray output = new JSONArray();
        for (OcrRow row : rows) {
            try {
                output.put(row.toJson());
            } catch (Exception ignored) {
                // OCR geometry is optional parser evidence.
            }
        }
        return output;
    }

    private static int integer(String value) {
        try {
            return Integer.parseInt(value);
        } catch (Exception ignored) {
            return -1;
        }
    }

    private static double decimal(String value) {
        try {
            return Double.parseDouble(value);
        } catch (Exception ignored) {
            return -1d;
        }
    }

    private static Double first(Double current, double value) {
        return current == null ? value : current;
    }

    private static String compact(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }
}
