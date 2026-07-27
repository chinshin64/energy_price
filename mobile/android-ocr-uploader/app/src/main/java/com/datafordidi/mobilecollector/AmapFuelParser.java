package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 高德加油页面解析策略。
 *
 * <p>覆盖列表页与详情页两种形态：
 * <ul>
 *   <li>列表页：站名 + 各油号价格行（如 92# ¥7.19/L）。</li>
 *   <li>详情页：站名 + 共用油站价/国标价 + 各油号优惠金额 + 实付价。</li>
 * </ul>
 *
 * <p>原则：优惠金额不能单独作为油价，必须与同域油站价/国标价/实付价绑定。
 */
final class AmapFuelParser implements FuelCardParser {

    // 每升优惠金额范围（元/升）：0.01 ~ 10.00，不经过油价范围校验。
    private static final Pattern DISCOUNT_AMOUNT = Pattern.compile(
            "(?:[¥￥vVxX]\\s*)?([0-9]+(?:[.,][0-9]{1,4})?)\\s*(?:元)?"
    );
    private static final Pattern GUN_NUMBER = Pattern.compile("^\\s*([0-9]{1,3})\\s*号?\\s*$");
    private static final Pattern PER_LITER_PRICE = Pattern.compile(
            "([0-9]{1,2}(?:[.,][0-9]{1,4})?)\\s*(?:元)?\\s*(?:/L|/升|元/L|元/升)"
    );
    private static final Pattern PROMOTION_DISCOUNT = Pattern.compile(
            "(?:加|约)?[0-9]+(?:\\.[0-9]+)?(?:省|减|降|折)"
    );
    private static final Pattern AMOUNT_BUTTON = Pattern.compile("^[¥￥]?\\s*(100|200|300|400|500)\\s*(?:元)?$");

    @Override
    public FuelCardParser.FuelParseResult parse(List<OcrRow> inputRows, String platform, String sourceStage) {
        List<FuelStationRecord> stations = new ArrayList<>();
        List<String> rejectionReasons = new ArrayList<>();
        List<JSONObject> priceEvidence = new ArrayList<>();
        if (inputRows == null || inputRows.isEmpty()) return FuelCardParser.FuelParseResult.empty();

        List<OcrRow> rows = FuelCardParser.Utilities.sortedCopy(inputRows);
        List<OcrRow> titleCandidates = extractTitles(rows);
        if (titleCandidates.isEmpty()) {
            rejectionReasons.add("no-station-title");
            return new FuelCardParser.FuelParseResult(stations, rejectionReasons, priceEvidence);
        }

        // 高德详情页通常只有一个站名；列表页可能有多个卡片。
        for (int index = 0; index < titleCandidates.size(); index++) {
            OcrRow title = titleCandidates.get(index);
            OcrRow nextTitle = nextTitleInColumn(titleCandidates, title);
            float bottom = nextTitle == null
                    ? Math.min(1f, title.y + 0.45f)
                    : nextTitle.y - 0.006f;
            List<OcrRow> card = cardRows(rows, title, bottom);
            FuelStationRecord station = parseCard(title, card, platform, sourceStage, priceEvidence);
            if (station == null || station.fuelOffers.isEmpty()) {
                rejectionReasons.add("no-valid-offer");
                continue;
            }
            stations.add(station);
        }
        return new FuelCardParser.FuelParseResult(stations, rejectionReasons, priceEvidence);
    }

    private FuelStationRecord parseCard(
            OcrRow title,
            List<OcrRow> card,
            String platform,
            String sourceStage,
            List<JSONObject> evidenceCollector
    ) {
        // 1. 按油号把卡片拆分为子卡片；支持同一行多个横向油号 tab（如 92# 95# 0#柴油）。
        List<GradeAnchor> anchors = collectGradeAnchors(card);
        Map<String, List<OcrRow>> gradeRows = assignRowsToGrades(card, anchors);
        List<OcrRow> sharedRows = collectSharedRows(card, anchors, gradeRows);

        // 2. 解析共享区：油站价 / 国标价 / 外显价。
        SharedPrice shared = parseSharedPrices(sharedRows);

        // 3. 解析每个油号子卡片，并过滤掉柴油（0#/-10#）。
        Map<String, FuelOffer> offers = new LinkedHashMap<>();
        for (Map.Entry<String, List<OcrRow>> entry : gradeRows.entrySet()) {
            String code = entry.getKey();
            if ("0".equals(code) || "-10".equals(code)) continue; // 只采集汽油
            List<OcrRow> subRows = entry.getValue();
            FuelOffer offer = parseGradeOffer(code, subRows, shared, evidenceCollector);
            if (offer != null) offers.put(code, offer);
        }

        if (offers.isEmpty()) return null;
        FuelStationRecord station = emptyStation(title, platform, sourceStage);
        station.fuelOffers.addAll(offers.values());
        return station;
    }

    private SharedPrice parseSharedPrices(List<OcrRow> rows) {
        SharedPrice shared = new SharedPrice();
        for (OcrRow row : rows) {
            String text = row.text;
            if (isBlockedForAmap(text)
                    || isGunNumberLine(text)
                    || isPromotionLine(text)
                    || isAmountButtonLine(text)) continue;
            if (isDiscountLine(text)) {
                BigDecimal amount = extractDiscountAmount(text);
                if (amount != null && shared.discountAmount == null) {
                    shared.discountAmount = amount;
                }
                continue;
            }
            FuelCardParser.PriceRole role = priceRoleForAmap(text);
            List<BigDecimal> values = prices(text);
            for (BigDecimal value : values) {
                if (!isReasonableDisplayPrice(value)) continue;
                if (role == FuelCardParser.PriceRole.STATION && shared.stationPrice == null) {
                    shared.stationPrice = value;
                } else if (role == FuelCardParser.PriceRole.NATIONAL && shared.nationalPrice == null) {
                    shared.nationalPrice = value;
                } else if (role == FuelCardParser.PriceRole.LIST && shared.listPrice == null) {
                    shared.listPrice = value;
                }
            }
        }
        return shared;
    }

    private FuelOffer parseGradeOffer(
            String code,
            List<OcrRow> rows,
            SharedPrice shared,
            List<JSONObject> evidenceCollector
    ) {
        FuelOffer offer = new FuelOffer();
        offer.gradeCode = code;
        offer.gradeLabel = FuelCardParser.Utilities.gradeLabel(code);
        offer.fuelType = FuelCardParser.Utilities.fuelType(FuelCardParser.Utilities.gradeLabel(code));

        BigDecimal discountAmount = null; // 每升优惠金额
        boolean hasExplicitDisplay = false;

        for (OcrRow row : rows) {
            String text = row.text;
            if (isBlockedForAmap(text)
                    || isGunNumberLine(text)
                    || isPromotionLine(text)
                    || isAmountButtonLine(text)) continue;
            String rowGrade = FuelCardParser.Utilities.gradeCode(text);
            FuelCardParser.PriceRole role = priceRoleForAmap(text);

            // “优惠 ¥0.2/L”或“油站价直降0.30/L”——这是每升优惠额，不是油价本身。
            if (isDiscountLine(text)) {
                BigDecimal amount = extractDiscountAmount(text);
                if (amount != null && discountAmount == null) {
                    discountAmount = amount;
                    collectEvidence(evidenceCollector, "discount-amount", row, code);
                }
                continue;
            }

            List<BigDecimal> values = prices(text);
            for (BigDecimal value : values) {
                if (!isReasonableDisplayPrice(value)) continue;
                if (role == FuelCardParser.PriceRole.STATION) {
                    if (offer.stationPrice == null) offer.stationPrice = value;
                } else if (role == FuelCardParser.PriceRole.NATIONAL) {
                    if (offer.nationalPrice == null) offer.nationalPrice = value;
                } else if (role == FuelCardParser.PriceRole.DISPLAY) {
                    if (offer.displayPrice == null) {
                        offer.displayPrice = value;
                        offer.discountPrice = value.doubleValue();
                        offer.discountKind = "display";
                        hasExplicitDisplay = true;
                    }
                } else if (role == FuelCardParser.PriceRole.LIST) {
                    if (offer.listPrice == null) offer.listPrice = value.doubleValue();
                } else if (role == FuelCardParser.PriceRole.DISCOUNT) {
                    if (discountAmount == null) discountAmount = value;
                } else if (role == FuelCardParser.PriceRole.UNCLASSIFIED) {
                    // 未分类价格：带 /L 的优先；孤立纯油价数字只在共享区没有 displayPrice 时作为候选。
                    if (offer.displayPrice == null && hasPerLiterMarker(text)) {
                        offer.displayPrice = value;
                    } else if (offer.displayPrice == null
                            && shared.displayPrice == null
                            && isIsolatedPriceRow(text)) {
                        offer.displayPrice = value;
                    }
                }
            }
        }

        // 使用共享区基准价回填本油号缺失的角色价格（仅当本油号没有任何价格时）。
        // 高德详情页油站价/国标价通常随油号切换，不跨油号回填，避免把 95# 价格填给 92#。
        if (!offer.hasRolePrice() && shared.stationPrice != null) {
            offer.stationPrice = shared.stationPrice;
        }
        if (!offer.hasRolePrice() && shared.nationalPrice != null) {
            offer.nationalPrice = shared.nationalPrice;
        }
        if (offer.listPrice == null && shared.listPrice != null) {
            offer.listPrice = shared.listPrice.doubleValue();
        }
        if (offer.listPrice == null && offer.stationPrice != null) {
            offer.listPrice = offer.stationPrice.doubleValue();
        }
        if (offer.listPrice == null && offer.nationalPrice != null) {
            offer.listPrice = offer.nationalPrice.doubleValue();
        }
        // 共享区不再回填 displayPrice，避免外显价跨油号污染。

        // 没有显式外显价但有油站价和每升优惠时，计算外显价。
        if (!hasExplicitDisplay && offer.displayPrice == null
                && offer.stationPrice != null && discountAmount != null) {
            BigDecimal computed = offer.stationPrice.subtract(discountAmount);
            if (isReasonableDisplayPrice(computed)) {
                offer.displayPrice = computed;
            }
        }

        // 优惠金额进入 discountPrice（语义：每升优惠）。
        if (discountAmount == null && shared.discountAmount != null) {
            discountAmount = shared.discountAmount;
        }
        if (discountAmount != null) {
            offer.discountPrice = discountAmount.doubleValue();
            offer.discountKind = "per-liter";
        }

        return offer.valid() ? offer : null;
    }

    private boolean isDiscountLine(String text) {
        String value = FuelCardParser.Utilities.clean(text);
        // 每升优惠说明：明确含“优惠/直降/降”动作词，且带油价单位（/L 或 元/升）。
        // 注意：含“省/减”但不带动作词的通常是“加200省X”这种订单级优惠，由 quote 解析处理。
        boolean hasDiscountWord = value.contains("优惠") || value.contains("直降") || value.contains("降");
        if (!hasDiscountWord) return false;
        boolean hasStationPriceWord = value.contains("油站价") || value.contains("国标价") || value.contains("外显价");
        if (hasStationPriceWord) return hasPerLiterMarker(text);
        // 不含油站价/国标价/外显价时，只有带油价单位才认为是每升优惠（如“92# 优惠¥0.38/L”）。
        return hasPerLiterMarker(text);
    }

    private BigDecimal extractDiscountAmount(String text) {
        Matcher matcher = DISCOUNT_AMOUNT.matcher(FuelCardParser.Utilities.clean(text));
        while (matcher.find()) {
            String token = matcher.group(1).replace(',', '.');
            try {
                BigDecimal value = new BigDecimal(token);
                if (value.compareTo(new BigDecimal("0.01")) >= 0
                        && value.compareTo(new BigDecimal("10.00")) <= 0
                        && value.stripTrailingZeros().scale() <= 4) {
                    return value;
                }
            } catch (NumberFormatException ignored) {
            }
        }
        return null;
    }

    private static boolean isGunNumberLine(String text) {
        String value = FuelCardParser.Utilities.clean(text);
        return GUN_NUMBER.matcher(value).matches();
    }

    private static boolean isPromotionLine(String text) {
        String value = FuelCardParser.Utilities.clean(text);
        // 带明确“元/升”或“/L”的价格行，即使含营销后缀也不整行丢弃。
        if (hasPerLiterMarker(text)) return false;
        return PROMOTION_DISCOUNT.matcher(value).find()
                || value.matches(".*(?:低至|约|立减|直降|满)[0-9]+(?:\\.[0-9]+)?.*")
                || value.contains("折");
    }

    private static boolean isAmountButtonLine(String text) {
        String value = FuelCardParser.Utilities.clean(text);
        return AMOUNT_BUTTON.matcher(value).matches();
    }

    private static boolean isBlockedForAmap(String text) {
        String value = FuelCardParser.Utilities.clean(text);
        // 带明确油价单位（/L 或 元/升）的行即使含营销文案也保留，避免把外显价整行丢弃。
        if (hasPerLiterMarker(text)) return false;
        return FuelCardParser.Utilities.blocked(value);
    }

    private static boolean isPerLiterDiscountLine(String text) {
        String value = FuelCardParser.Utilities.clean(text);
        if (!hasPerLiterMarker(text)) return false;
        boolean hasStationPriceWord = value.contains("油站价") || value.contains("国标价") || value.contains("外显价");
        boolean hasDiscountWord = value.contains("直降") || value.contains("降") || value.contains("省")
                || value.contains("优惠") || value.contains("减");
        // “油站价直降0.30/L”这种行是每升优惠说明，不是油站价本身。
        return hasStationPriceWord && hasDiscountWord;
    }

    private static FuelCardParser.PriceRole priceRoleForAmap(String text) {
        FuelCardParser.PriceRole role = FuelCardParser.Utilities.priceRole(text);
        // 带明确油价单位的行，即使被通用营销规则标记为 BLOCKED，也按未分类价格处理。
        if (role == FuelCardParser.PriceRole.BLOCKED && hasPerLiterMarker(text)) {
            return FuelCardParser.PriceRole.UNCLASSIFIED;
        }
        return role;
    }

    private static boolean hasPerLiterMarker(String text) {
        String value = FuelCardParser.Utilities.clean(text);
        return value.contains("/L") || value.contains("/升") || value.contains("元/L") || value.contains("元/升");
    }

    private static boolean isIsolatedPriceRow(String text) {
        String value = FuelCardParser.Utilities.clean(text);
        return value.matches("^[¥￥]?[0-9]+(?:\\.[0-9]{1,3})?$");
    }

    private static boolean isReasonableDisplayPrice(BigDecimal value) {
        return value != null
                && value.compareTo(new BigDecimal("0.50")) >= 0
                && value.compareTo(new BigDecimal("15.00")) <= 0;
    }

    private static List<BigDecimal> prices(String text) {
        List<BigDecimal> output = new ArrayList<>();
        Matcher matcher = PER_LITER_PRICE.matcher(FuelCardParser.Utilities.clean(text));
        while (matcher.find()) {
            String token = matcher.group(1).replace(',', '.');
            try {
                BigDecimal decimal = new BigDecimal(token).stripTrailingZeros();
                if (decimal.scale() <= 4) output.add(decimal);
            } catch (NumberFormatException ignored) {
            }
        }
        if (!output.isEmpty()) return output;
        return FuelCardParser.Utilities.prices(text);
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

    private List<OcrRow> extractTitles(List<OcrRow> rows) {
        List<OcrRow> output = new ArrayList<>();
        for (OcrRow row : rows) {
            String value = FuelCardParser.Utilities.cleanStationName(row.text);
            if (FuelCardParser.Utilities.looksLikeStationName(value)) output.add(row);
        }
        return output;
    }

    private OcrRow nextTitleInColumn(List<OcrRow> titles, OcrRow title) {
        OcrRow next = null;
        for (OcrRow candidate : titles) {
            if (candidate == title || candidate.y <= title.y + 0.01f) continue;
            if (!FuelCardParser.Utilities.sameColumn(candidate, title)) continue;
            if (next == null || candidate.y < next.y) next = candidate;
        }
        return next;
    }

    private static List<OcrRow> cardRows(List<OcrRow> rows, OcrRow title, float bottom) {
        List<OcrRow> output = new ArrayList<>();
        for (OcrRow row : rows) {
            if (row.y + row.height < title.y - 0.006f || row.y > bottom) continue;
            output.add(row);
        }
        return output;
    }

    private FuelStationRecord emptyStation(OcrRow title, String platform, String sourceStage) {
        FuelStationRecord station = new FuelStationRecord();
        station.platform = platform;
        station.stationName = FuelCardParser.Utilities.cleanStationName(title.text);
        if (!station.stationName.equals(title.text == null ? "" : title.text.trim())) {
            station.observedStationName = title.text == null ? "" : title.text.trim();
            station.stationNameMatchMethod = "search-shell-normalized";
        }
        station.address = null;
        station.sourceStage = sourceStage == null ? "screen-ocr-manual-scroll" : sourceStage;
        station.localParser = "amap-fuel-android-ocr";
        station.captureContextId = DeviceIdentity.sha256(
                platform + "|" + station.stationName + "|" + Math.round(title.x * 100)
        ).substring(0, 12);
        return station;
    }

    private void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化高德燃油证据", error);
        }
    }

    private static final class SharedPrice {
        BigDecimal stationPrice;
        BigDecimal nationalPrice;
        BigDecimal displayPrice;
        BigDecimal listPrice;
        BigDecimal discountAmount;
    }

    /**
     * 油号锚点：用于把横向油号 tab 下方的内容分配给对应油号。
     */
    private static final class GradeAnchor {
        final String gradeCode;
        final String gradeLabel;
        final float x;
        final float y;
        final float width;

        GradeAnchor(String gradeCode, String gradeLabel, float x, float y, float width) {
            this.gradeCode = gradeCode;
            this.gradeLabel = gradeLabel;
            this.x = x;
            this.y = y;
            this.width = width;
        }
    }

    /**
     * 把一行含多个油号的文案拆成多个 snippet，每个 snippet 只含对应油号及右侧内容，
     * 用于“92# 优惠¥0.38/L 95# 优惠¥0.4/L”这种横向 tab 行。
     */
    private static void addGradeRowSnippets(OcrRow row, Map<String, List<OcrRow>> gradeRows) {
        String text = row.text;
        Matcher matcher = FuelCardParser.Utilities.gradePattern().matcher(text);
        List<int[]> matches = new ArrayList<>();
        while (matcher.find()) {
            matches.add(new int[]{matcher.start(), matcher.end()});
        }
        for (int i = 0; i < matches.size(); i++) {
            int[] m = matches.get(i);
            int codeStart = m[0];
            int codeEnd = m[0];
            // 找油号数字结束位置（如 92# 中的 # 之后）。
            while (codeEnd < m[1] && text.charAt(codeEnd) != '#'
                    && text.charAt(codeEnd) != '＃') {
                codeEnd++;
            }
            if (codeEnd < m[1]) codeEnd++;
            String code = text.substring(codeStart, codeEnd).replaceAll("[\\s#＃]", "");
            int end = i + 1 < matches.size() ? matches.get(i + 1)[0] : text.length();
            String snippetText = text.substring(codeStart, end);
            float ratioStart = text.length() > 0 ? codeStart / (float) text.length() : 0f;
            float ratioEnd = text.length() > 0 ? end / (float) text.length() : 1f;
            float snippetX = row.x + ratioStart * row.width;
            float snippetWidth = (ratioEnd - ratioStart) * row.width;
            OcrRow snippet = new OcrRow(snippetText, row.confidence, snippetX, row.y, snippetWidth, row.height);
            gradeRows.computeIfAbsent(code, k -> new ArrayList<>()).add(snippet);
        }
    }

    /**
     * 扫描卡片中所有油号出现的位置。同一行可能包含多个油号（如 92# 95# 0#柴油）。
     */
    private static List<GradeAnchor> collectGradeAnchors(List<OcrRow> rows) {
        List<GradeAnchor> anchors = new ArrayList<>();
        for (OcrRow row : rows) {
            String text = row.text;
            Matcher matcher = FuelCardParser.Utilities.gradePattern().matcher(text);
            while (matcher.find()) {
                String code = matcher.group(1);
                String label = code + "#";
                if (matcher.groupCount() >= 2 && matcher.group(2) != null) {
                    label = code + "#" + matcher.group(2);
                }
                float start = matcher.start();
                float ratio = text.length() > 0 ? start / text.length() : 0f;
                float anchorX = row.x + ratio * row.width;
                anchors.add(new GradeAnchor(code, label, anchorX, row.y, row.width));
            }
        }
        return anchors;
    }

    /**
     * 把非油号行分配给油号。油号 tab 上方的价格行（如外显价、国标价）按最近油号分配；
     * tab 下方的行按 x 区间分配。
     */
    private static Map<String, List<OcrRow>> assignRowsToGrades(
            List<OcrRow> rows,
            List<GradeAnchor> anchors
    ) {
        Map<String, List<OcrRow>> gradeRows = new LinkedHashMap<>();
        if (anchors.isEmpty()) return gradeRows;

        // 按 y 分组锚点，把同一 tab 行的锚点按 x 排序，构建 x 区间。
        Map<Float, List<GradeAnchor>> byY = new LinkedHashMap<>();
        for (GradeAnchor anchor : anchors) {
            byY.computeIfAbsent(anchor.y, k -> new ArrayList<>()).add(anchor);
        }
        List<GradeInterval> intervals = new ArrayList<>();
        float firstAnchorY = Float.MAX_VALUE;
        for (List<GradeAnchor> group : byY.values()) {
            group.sort(Comparator.comparingDouble(a -> a.x));
            for (int i = 0; i < group.size(); i++) {
                GradeAnchor a = group.get(i);
                if (a.y < firstAnchorY) firstAnchorY = a.y;
                float end = i + 1 < group.size() ? group.get(i + 1).x : 1f;
                intervals.add(new GradeInterval(a.gradeCode, a.x, end, a.y));
            }
        }

        for (OcrRow row : rows) {
            String text = row.text;
            if (!FuelCardParser.Utilities.gradeCode(text).isEmpty()) {
                // 把油号行按油号拆分成片段，保证每个油号能拿到自己的“优惠¥0.38/L”等文案。
                addGradeRowSnippets(row, gradeRows);
                continue;
            }
            String assigned = null;
            if (hasExplicitPriceRole(text)) {
                assigned = assignByNearestAnchorY(row, anchors, intervals);
            }
            if (assigned == null) {
                // 油号 tab 上方的行：按最近油号锚点（不严格限制 x 区间）。
                if (row.y + row.height / 2f < firstAnchorY - 0.03f) {
                    assigned = nearestGradeByDistance(row, anchors, intervals, 0.30f, false);
                } else {
                    assigned = assignGradeByX(row, intervals, anchors);
                }
            }
            if (assigned != null) {
                gradeRows.computeIfAbsent(assigned, k -> new ArrayList<>()).add(row);
            }
        }
        return gradeRows;
    }

    /**
     * 按与锚点的综合距离找最近油号。y 差不超过 maxYDistance，若 requireXInterval 为 true 则还需落在 x 区间内。
     */
    private static String nearestGradeByDistance(
            OcrRow row,
            List<GradeAnchor> anchors,
            List<GradeInterval> intervals,
            float maxYDistance,
            boolean requireXInterval
    ) {
        float targetX = row.x + row.width / 2f;
        String best = null;
        float bestDistance = Float.MAX_VALUE;
        for (GradeInterval interval : intervals) {
            if (Math.abs(interval.y - row.y) > maxYDistance) continue;
            if (requireXInterval) {
                if (targetX < interval.x - 0.05f || targetX >= interval.end + 0.05f) continue;
            }
            float dx = Math.min(
                    Math.abs(interval.x - targetX),
                    Math.abs(interval.end - targetX)
            );
            float dy = Math.abs(interval.y - row.y);
            float distance = dx + dy * 3f;
            if (distance < bestDistance) {
                bestDistance = distance;
                best = interval.gradeCode;
            }
        }
        if (best != null) return best;
        for (GradeAnchor anchor : anchors) {
            if (Math.abs(anchor.y - row.y) > maxYDistance) continue;
            float dx = Math.abs(anchor.x - targetX);
            float dy = Math.abs(anchor.y - row.y);
            float distance = dx + dy * 3f;
            if (distance < bestDistance) {
                bestDistance = distance;
                best = anchor.gradeCode;
            }
        }
        return best;
    }

    private static boolean hasExplicitPriceRole(String text) {
        String value = FuelCardParser.Utilities.clean(text);
        return value.contains("油站价") || value.contains("国标价") || value.contains("挂牌价")
                || value.contains("外显价") || value.contains("团油价") || value.contains("高德价");
    }

    private static String assignByNearestAnchorY(OcrRow row, List<GradeAnchor> anchors, List<GradeInterval> intervals) {
        String best = null;
        float bestDistance = Float.MAX_VALUE;
        float targetX = row.x + row.width / 2f;
        for (GradeInterval interval : intervals) {
            if (interval.y > row.y + 0.05f) continue;
            if (targetX < interval.x - 0.05f || targetX >= interval.end + 0.05f) continue;
            float distance = Math.abs(row.y - interval.y);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = interval.gradeCode;
            }
        }
        return best;
    }

    /**
     * 确定一行属于哪个油号区间。优先看行内第一个价格的 x 估算位置，否则看整行中点。
     */
    private static String assignGradeByX(
            OcrRow row,
            List<GradeInterval> intervals,
            List<GradeAnchor> anchors
    ) {
        // 看行内价格数字的位置。
        String text = row.text;
        Matcher priceMatcher = PER_LITER_PRICE.matcher(text);
        float targetX = Float.NaN;
        if (priceMatcher.find()) {
            int start = priceMatcher.start();
            targetX = row.x + (text.length() > 0 ? (start / (float) text.length()) : 0f) * row.width;
        }
        if (Float.isNaN(targetX)) {
            targetX = row.x + row.width / 2f;
        }

        // 允许价格行在油号上方或附近（详情页布局），y 差不超过 0.15。
        GradeInterval best = null;
        float bestDistance = Float.MAX_VALUE;
        for (GradeInterval interval : intervals) {
            if (Math.abs(interval.y - row.y) > 0.15f) continue;
            if (targetX < interval.x - 0.05f || targetX >= interval.end + 0.05f) continue;
            float distance = Math.abs(row.y - interval.y);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = interval;
            }
        }
        if (best != null) return best.gradeCode;

        // 回退：找最近的锚点（按欧氏距离），y 差不超过 0.15。
        GradeAnchor nearest = null;
        float nearestDistance = Float.MAX_VALUE;
        for (GradeAnchor anchor : anchors) {
            if (Math.abs(anchor.y - row.y) > 0.15f) continue;
            float dx = Math.abs(anchor.x - targetX);
            float dy = Math.abs(anchor.y - row.y);
            float distance = dx + dy * 3f;
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearest = anchor;
            }
        }
        return nearest == null ? null : nearest.gradeCode;
    }

    /**
     * 收集共享区：没有落在任何油号区间的行，且不是金额按钮/枪号/营销行。
     */
    private static List<OcrRow> collectSharedRows(
            List<OcrRow> rows,
            List<GradeAnchor> anchors,
            Map<String, List<OcrRow>> gradeRows
    ) {
        List<OcrRow> shared = new ArrayList<>();
        if (anchors.isEmpty()) {
            shared.addAll(rows);
            return shared;
        }
        for (OcrRow row : rows) {
            String text = row.text;
            if (!FuelCardParser.Utilities.gradeCode(text).isEmpty()) continue;
            boolean assigned = false;
            for (List<OcrRow> group : gradeRows.values()) {
                if (group.contains(row)) {
                    assigned = true;
                    break;
                }
            }
            if (assigned) continue;
            if (isBlockedForAmap(text) || isGunNumberLine(text) || isPromotionLine(text)
                    || isAmountButtonLine(text)) continue;
            shared.add(row);
        }
        return shared;
    }

    private static final class GradeInterval {
        final String gradeCode;
        final float x;
        final float end;
        final float y;

        GradeInterval(String gradeCode, float x, float end, float y) {
            this.gradeCode = gradeCode;
            this.x = x;
            this.end = end;
            this.y = y;
        }
    }
}
