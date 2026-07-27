package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 团油原生应用解析策略。
 *
 * <p>列表页：站名卡片 + 多油号价格行；详情页：油号切换 + 团油价/油站价/国标价标签。
 */
final class TuanyouFuelParser implements FuelCardParser {

    @Override
    public FuelParseResult parse(List<OcrRow> inputRows, String platform, String sourceStage) {
        List<FuelStationRecord> stations = new ArrayList<>();
        List<String> rejectionReasons = new ArrayList<>();
        List<JSONObject> priceEvidence = new ArrayList<>();
        if (inputRows == null || inputRows.isEmpty()) return FuelParseResult.empty();

        List<OcrRow> rows = Utilities.sortedCopy(inputRows);
        List<OcrRow> titleCandidates = extractTitles(rows);
        if (titleCandidates.isEmpty()) {
            rejectionReasons.add("no-station-title");
            return new FuelParseResult(stations, rejectionReasons, priceEvidence);
        }

        String globalGrade = defaultGrade(rows);
        for (OcrRow title : titleCandidates) {
            OcrRow nextTitle = nextTitleInColumn(titleCandidates, title);
            float bottom = nextTitle == null
                    ? Math.min(1f, title.y + 0.28f)
                    : nextTitle.y - 0.006f;
            List<OcrRow> card = Utilities.cardRows(rows, title, bottom);
            FuelStationRecord station = parseCard(title, card, globalGrade, platform, sourceStage, priceEvidence);
            if (station == null || station.fuelOffers.isEmpty()) {
                rejectionReasons.add("no-valid-offer");
                continue;
            }
            stations.add(station);
        }
        return new FuelParseResult(stations, rejectionReasons, priceEvidence);
    }

    private FuelStationRecord parseCard(
            OcrRow title,
            List<OcrRow> card,
            String globalGrade,
            String platform,
            String sourceStage,
            List<JSONObject> evidenceCollector
    ) {
        Map<String, FuelOffer> offers = new LinkedHashMap<>();
        String activeGrade = defaultGrade(card);
        if (activeGrade.isEmpty()) activeGrade = globalGrade;
        for (OcrRow row : card) {
            String text = row.text;
            if (Utilities.blocked(Utilities.clean(text))) continue;
            String grade = Utilities.gradeCode(text);
            if (!grade.isEmpty()) activeGrade = grade;

            FuelCardParser.PriceRole role = Utilities.priceRole(text);
            if (role == FuelCardParser.PriceRole.BLOCKED) continue;
            List<BigDecimal> values = Utilities.prices(text);
            for (BigDecimal value : values) {
                FuelCardParser.PriceRole resolved = resolveRole(role, row, card);
                if (resolved == FuelCardParser.PriceRole.BLOCKED) continue;
                String gradeValue = !grade.isEmpty() ? grade : activeGrade;
                if (gradeValue.isEmpty()) continue;
                FuelOffer offer = offers.computeIfAbsent(gradeValue, this::createOffer);
                applyPrice(offer, resolved, value, row, evidenceCollector, gradeValue);
            }
        }

        if (offers.isEmpty()) return null;
        FuelStationRecord station = emptyStation(title, platform, sourceStage);
        station.fuelOffers.addAll(offers.values());
        return station;
    }

    private String defaultGrade(List<OcrRow> rows) {
        for (OcrRow row : rows) {
            String code = Utilities.gradeCode(row.text);
            if (!code.isEmpty()) return code;
        }
        return "";
    }

    private FuelCardParser.PriceRole resolveRole(
            FuelCardParser.PriceRole inline,
            OcrRow priceRow,
            List<OcrRow> card
    ) {
        if (inline != FuelCardParser.PriceRole.UNCLASSIFIED) return inline;
        return nearbyRole(priceRow, card);
    }

    private FuelCardParser.PriceRole nearbyRole(OcrRow price, List<OcrRow> card) {
        FuelCardParser.PriceRole candidate = FuelCardParser.PriceRole.UNCLASSIFIED;
        float best = Float.MAX_VALUE;
        for (OcrRow label : card) {
            FuelCardParser.PriceRole role = Utilities.priceRole(label.text);
            if (role != FuelCardParser.PriceRole.LIST
                    && role != FuelCardParser.PriceRole.DISCOUNT
                    && role != FuelCardParser.PriceRole.DISPLAY
                    && role != FuelCardParser.PriceRole.STATION
                    && role != FuelCardParser.PriceRole.NATIONAL) {
                continue;
            }
            float yDistance = Math.abs(label.y - price.y);
            float xDistance = Math.abs(label.x - price.x);
            if (yDistance > 0.045f && !(label.y < price.y && price.y - label.y <= 0.075f)) continue;
            float distance = yDistance * 3f + xDistance;
            if (distance < best) {
                best = distance;
                candidate = role;
            }
        }
        return candidate;
    }

    private void applyPrice(
            FuelOffer offer,
            FuelCardParser.PriceRole role,
            BigDecimal value,
            OcrRow row,
            List<JSONObject> evidenceCollector,
            String gradeCode
    ) {
        if (!FuelOffer.validRolePrice(value)) return;
        double legacyValue = value.doubleValue();
        switch (role) {
            case LIST:
                if (offer.listPrice == null) offer.listPrice = legacyValue;
                break;
            case DISCOUNT:
                if (offer.discountPrice == null) {
                    offer.discountPrice = legacyValue;
                    offer.discountKind = "explicit";
                }
                break;
            case DISPLAY:
                if (offer.displayPrice == null) {
                    offer.displayPrice = value;
                    offer.discountPrice = choose(offer.discountPrice, legacyValue);
                    offer.discountKind = "explicit";
                }
                break;
            case STATION:
                if (offer.stationPrice == null) offer.stationPrice = BigDecimal.valueOf(legacyValue);
                if (offer.listPrice == null) offer.listPrice = legacyValue;
                break;
            case NATIONAL:
                if (offer.nationalPrice == null) offer.nationalPrice = BigDecimal.valueOf(legacyValue);
                if (offer.listPrice == null) offer.listPrice = legacyValue;
                break;
            case UNCLASSIFIED:
            default:
                if (offer.unclassifiedPrice == null) offer.unclassifiedPrice = legacyValue;
                break;
        }
        collectEvidence(
                evidenceCollector,
                role.name().toLowerCase(java.util.Locale.ROOT),
                row,
                gradeCode
        );
    }

    private void collectEvidence(
            List<JSONObject> collector,
            String kind,
            OcrRow row,
            String gradeCode
    ) {
        if (collector == null || collector.size() >= 8) return;
        JSONObject evidence = new JSONObject();
        put(evidence, "kind", kind);
        put(evidence, "gradeCode", gradeCode);
        put(evidence, "x", row.x);
        put(evidence, "y", row.y);
        put(evidence, "width", row.width);
        put(evidence, "height", row.height);
        collector.add(evidence);
    }

    private FuelOffer createOffer(String gradeCode) {
        FuelOffer offer = new FuelOffer();
        offer.gradeCode = gradeCode;
        offer.gradeLabel = Utilities.gradeLabel(gradeCode);
        offer.fuelType = Utilities.fuelType(Utilities.gradeLabel(gradeCode));
        return offer;
    }

    private Double choose(Double current, double incoming) {
        return current == null ? incoming : current;
    }

    private List<OcrRow> extractTitles(List<OcrRow> rows) {
        List<OcrRow> output = new ArrayList<>();
        for (OcrRow row : rows) {
            String value = Utilities.cleanStationName(row.text);
            if (Utilities.looksLikeStationName(value)) output.add(row);
        }
        return output;
    }

    private OcrRow nextTitleInColumn(List<OcrRow> titles, OcrRow title) {
        OcrRow next = null;
        for (OcrRow candidate : titles) {
            if (candidate == title || candidate.y <= title.y + 0.01f) continue;
            if (!Utilities.sameColumn(candidate, title)) continue;
            if (next == null || candidate.y < next.y) next = candidate;
        }
        return next;
    }

    private FuelStationRecord emptyStation(OcrRow title, String platform, String sourceStage) {
        FuelStationRecord station = new FuelStationRecord();
        station.platform = platform;
        station.stationName = Utilities.cleanStationName(title.text);
        station.address = null;
        station.sourceStage = sourceStage == null ? "screen-ocr-manual-scroll" : sourceStage;
        station.localParser = "tuanyou-android-ocr";
        station.captureContextId = DeviceIdentity.sha256(
                platform + "|" + station.stationName + "|" + Math.round(title.x * 100)
        ).substring(0, 12);
        return station;
    }

    private void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化团油燃油证据", error);
        }
    }
}
