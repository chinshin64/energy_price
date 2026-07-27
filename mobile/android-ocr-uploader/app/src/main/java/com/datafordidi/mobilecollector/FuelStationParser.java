package com.datafordidi.mobilecollector;

import java.util.ArrayList;
import java.util.List;

/**
 * 燃油场站解析兼容门面。
 *
 * <p>v1.3.9 起内部按平台分派到独立策略解析器；保留此类以避免大量调用方修改。
 */
final class FuelStationParser {

    private FuelStationParser() {
    }

    /**
     * 从 OCR rows 中提取燃油场站记录。
     *
     * @param inputRows  OCR 原始行
     * @param platform   平台标识，如 tuanyou / amap-fuel / generic-fuel-xxx
     * @param sourceStage 来源阶段
     * @return 燃油场站记录列表，不会返回 null
     */
    static List<FuelStationRecord> extract(
            List<OcrRow> inputRows,
            String platform,
            String sourceStage
    ) {
        return extractDetailed(inputRows, platform, sourceStage).stations;
    }

    static ParseOutcome extractDetailed(
            List<OcrRow> inputRows,
            String platform,
            String sourceStage
    ) {
        FuelCardParser parser = FuelParserFactory.create(platform);
        FuelCardParser.FuelParseResult result = parser.parse(inputRows, platform, sourceStage);
        List<String> rejectionReasons = new ArrayList<>(result.rejectionReasons);
        List<FuelStationRecord> stations = sanitizeStations(result.stations, rejectionReasons);

        // 全页维度补充：服务商归属与报价页（支付页）信息。
        FuelProviderExtractor.Result provider = FuelProviderExtractor.extract(inputRows);
        List<FuelQuote> quotes = new ArrayList<>();
        if (stations.size() == 1) {
            quotes = FuelQuoteParser.extract(inputRows, sourceStage, stations.get(0).fuelOffers);
        } else if (stations.isEmpty()) {
            quotes = FuelQuoteParser.extract(inputRows, sourceStage, null);
        }

        if (stations.size() == 1) {
            FuelStationRecord station = stations.get(0);
            if (provider.present()) {
                station.providerName = provider.name;
                station.providerEvidence = provider.evidence;
            }
            station.addQuote(quotes == null || quotes.isEmpty() ? null : quotes.get(0));
            return new ParseOutcome(stations, rejectionReasons, result.priceEvidence);
        }

        // 报价页/支付页兜底：没有识别出场站卡片，但 quote 有效时，
        // 尝试从页面顶部找一个站名作为兜底身份，避免 quote 丢失。
        if (stations.isEmpty() && quotes != null && !quotes.isEmpty()) {
            FuelQuote quote = quotes.get(0);
            FuelStationRecord fallback = fallbackFromQuote(inputRows, platform, sourceStage, quote);
            if (fallback != null) {
                if (provider.present()) {
                    fallback.providerName = provider.name;
                    fallback.providerEvidence = provider.evidence;
                }
                stations.add(fallback);
            } else {
                addReason(rejectionReasons, "quote-fallback-no-title");
            }
        } else if (stations.isEmpty()) {
            addReason(rejectionReasons, "quote-not-detected");
        }

        inferMissingGradesByPrice(stations);
        return new ParseOutcome(stations, rejectionReasons, result.priceEvidence);
    }

    private static List<FuelStationRecord> sanitizeStations(
            List<FuelStationRecord> input,
            List<String> rejectionReasons
    ) {
        List<FuelStationRecord> output = new ArrayList<>();
        if (input == null) return output;
        for (FuelStationRecord station : input) {
            if (station == null) continue;
            String observed = station.stationName == null ? "" : station.stationName.trim();
            String normalized = FuelStationNameNormalizer.normalize(observed);
            if (normalized.isEmpty()) normalized = observed;
            if (FuelStationNameNormalizer.hasSearchShellNoise(normalized)) {
                addReason(rejectionReasons, "station-name-search-shell-residual-retained");
                if (station.observedStationName == null
                        || station.observedStationName.trim().isEmpty()) {
                    station.observedStationName = observed;
                }
                station.stationNameMatchMethod = "parser-residual-retained";
            }
            if (!normalized.equals(observed)) {
                if (station.observedStationName == null
                        || station.observedStationName.trim().isEmpty()) {
                    station.observedStationName = observed;
                }
                if (!"parser-residual-retained".equals(station.stationNameMatchMethod)) {
                    station.stationNameMatchMethod = "parser-final-normalized";
                }
                station.stationName = normalized;
            }
            output.add(station);
        }
        return output;
    }

    private static void addReason(List<String> reasons, String value) {
        if (reasons != null && value != null && !reasons.contains(value)) reasons.add(value);
    }

    /**
     * 对相同站名的多组报价，如果某个 offer 没有明确油号，
     * 则按外显价相对高低推断：更贵默认 95，更便宜默认 92；
     * 若已有明确油号则保持原值。
     */
    private static void inferMissingGradesByPrice(List<FuelStationRecord> stations) {
        if (stations == null || stations.size() < 2) return;
        java.util.Map<String, List<FuelStationRecord>> groups = new java.util.HashMap<>();
        for (FuelStationRecord station : stations) {
            String key = station.stationName == null ? "" : station.stationName;
            groups.computeIfAbsent(key, k -> new ArrayList<>()).add(station);
        }
        for (List<FuelStationRecord> group : groups.values()) {
            if (group.size() < 2) continue;
            List<FuelOffer> offers = new ArrayList<>();
            for (FuelStationRecord station : group) {
                for (FuelOffer offer : station.fuelOffers) offers.add(offer);
            }
            if (offers.size() < 2) continue;
            offers.sort((a, b) -> a.displayPrice.compareTo(b.displayPrice));
            String[] gradeByRank = {"92", "95", "98", "101"};
            int rank = 0;
            for (FuelOffer offer : offers) {
                if (offer.gradeCode == null || offer.gradeCode.isEmpty()) {
                    int idx = Math.min(rank, gradeByRank.length - 1);
                    offer.gradeCode = gradeByRank[idx];
                    offer.gradeLabel = gradeByRank[idx] + "#";
                }
                rank++;
            }
        }
    }

    private static FuelStationRecord fallbackFromQuote(
            List<OcrRow> rows,
            String platform,
            String sourceStage,
            FuelQuote quote
    ) {
        if (rows == null || rows.isEmpty()) return null;
        OcrRow topTitle = null;
        for (OcrRow row : rows) {
            String value = FuelCardParser.Utilities.cleanStationName(row.text);
            if (FuelCardParser.Utilities.looksLikeStationName(value)) {
                if (topTitle == null || row.y < topTitle.y) topTitle = row;
            }
        }
        if (topTitle == null) return null;
        FuelStationRecord station = new FuelStationRecord();
        station.platform = platform;
        station.stationName = FuelCardParser.Utilities.cleanStationName(topTitle.text);
        station.capturedAt = quote.capturedAt;
        station.sourceStage = sourceStage == null ? "screen-ocr-fuel-quote" : sourceStage;
        station.localParser = "amap-fuel-quote-fallback";
        station.captureContextId = DeviceIdentity.sha256(
                platform + "|" + station.stationName + "|" + Math.round(topTitle.x * 100)
        ).substring(0, 12);
        station.addQuote(quote);
        return station;
    }

    static final class ParseOutcome {
        final List<FuelStationRecord> stations;
        final List<String> rejectionReasons;
        final List<org.json.JSONObject> priceEvidence;

        ParseOutcome(
                List<FuelStationRecord> stations,
                List<String> rejectionReasons,
                List<org.json.JSONObject> priceEvidence
        ) {
            this.stations = stations == null ? new ArrayList<>() : stations;
            this.rejectionReasons = rejectionReasons == null ? new ArrayList<>() : rejectionReasons;
            this.priceEvidence = priceEvidence == null ? new ArrayList<>() : priceEvidence;
        }
    }
}
