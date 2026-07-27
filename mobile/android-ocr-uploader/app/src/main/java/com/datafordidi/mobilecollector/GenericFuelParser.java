package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 通用燃油页面解析策略。
 *
 * <p>适用于未知加油站小程序或原生应用。只要求页面存在：
 * <ul>
 *   <li>场站标题（含加油站/油站/石化等词）</li>
 *   <li>至少一个油号与对应价格</li>
 * </ul>
 */
final class GenericFuelParser implements FuelCardParser {

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

        for (OcrRow title : titleCandidates) {
            OcrRow nextTitle = nextTitleInColumn(titleCandidates, title);
            float bottom = nextTitle == null
                    ? Math.min(1f, title.y + 0.26f)
                    : nextTitle.y - 0.006f;
            List<OcrRow> card = Utilities.cardRows(rows, title, bottom);
            FuelStationRecord station = parseCard(title, card, platform, sourceStage, priceEvidence);
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
            String platform,
            String sourceStage,
            List<JSONObject> evidenceCollector
    ) {
        Map<String, FuelOffer> offers = new LinkedHashMap<>();
        String activeGrade = "";
        List<PendingPrice> pendingPrices = new ArrayList<>();

        for (OcrRow row : card) {
            String text = row.text;
            if (Utilities.blocked(Utilities.clean(text))) continue;
            String grade = Utilities.gradeCode(text);
            if (!grade.isEmpty()) {
                // 遇到新油号时，先把 pending 的价格绑定到上一个油号。
                if (!activeGrade.isEmpty()) {
                    bindPending(offers, activeGrade, pendingPrices, evidenceCollector);
                }
                activeGrade = grade;
                pendingPrices.clear();
            }
            FuelCardParser.PriceRole role = Utilities.priceRole(text);
            if (role == FuelCardParser.PriceRole.BLOCKED) continue;
            List<BigDecimal> values = Utilities.prices(text);
            for (BigDecimal value : values) {
                pendingPrices.add(new PendingPrice(value, role, row));
            }
        }
        if (!activeGrade.isEmpty()) {
            bindPending(offers, activeGrade, pendingPrices, evidenceCollector);
        }

        if (offers.isEmpty()) return null;
        FuelStationRecord station = emptyStation(title, platform, sourceStage);
        station.fuelOffers.addAll(offers.values());
        return station;
    }

    private void bindPending(
            Map<String, FuelOffer> offers,
            String gradeCode,
            List<PendingPrice> pending,
            List<JSONObject> evidenceCollector
    ) {
        if (pending.isEmpty()) return;
        FuelOffer offer = offers.computeIfAbsent(gradeCode, this::createOffer);
        // 优先使用带明确角色的价格；多个未分类价格取第一个。
        for (PendingPrice pp : pending) {
            applyPrice(offer, pp.role, pp.value, pp.row, evidenceCollector, gradeCode);
        }
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
                    offer.discountPrice = legacyValue;
                    offer.discountKind = "display";
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
                if (offer.displayPrice == null) offer.displayPrice = value;
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
        station.localParser = "generic-fuel-android-ocr";
        station.captureContextId = DeviceIdentity.sha256(
                platform + "|" + station.stationName + "|" + Math.round(title.x * 100)
        ).substring(0, 12);
        return station;
    }

    private void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化通用燃油证据", error);
        }
    }

    private static final class PendingPrice {
        final BigDecimal value;
        final FuelCardParser.PriceRole role;
        final OcrRow row;

        PendingPrice(BigDecimal value, FuelCardParser.PriceRole role, OcrRow row) {
            this.value = value;
            this.role = role;
            this.row = row;
        }
    }
}
