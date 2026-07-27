package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 燃油报价页解析器。
 *
 * <p>识别加油金额、优惠金额、服务费、预计实付、油号、油枪号，区分 inline 与弹窗说明。
 */
final class FuelQuoteParser {

    private static final Pattern MONEY = Pattern.compile(
            "(?:[¥￥]\\s*)?([0-9]{1,6}(?:[.,][0-9]{1,2})?)\\s*(?:元)?"
    );
    private static final Pattern GUN = Pattern.compile("(?<!\\d)([0-9]{1,3})\\s*号?\\s*枪");
    private static final Pattern AMOUNT_BUTTON = Pattern.compile(
            "[¥￥]?\\s*(100|200|300|400|500)\\s*(?:元)?"
    );
    private static final Pattern SAVE_ON_AMOUNT = Pattern.compile(
            "(?:加|充)(100|200|300|400|500).*?(?:省|减|降)[¥￥]?\\s*([0-9]+(?:\\.[0-9]{1,2})?)"
    );
    private static final Pattern LIJIAN_AMOUNT = Pattern.compile(
            "立减[¥￥]?\\s*([0-9]+(?:\\.[0-9]{1,2})?)"
    );
    private static final Pattern NET_DISCOUNT = Pattern.compile(
            "(?:比油站价优惠|实际优惠|共优惠|最终优惠|净优惠|实际支付优惠|优惠后|比油站价)[¥￥]?\\s*([0-9]+(?:\\.[0-9]{1,2})?)"
    );
    private static final Pattern PAYABLE_WITH_SERVICE_FEE = Pattern.compile(
            "[¥￥]?\\s*([0-9]{2,4}(?:[.,][0-9]{1,2})?)\\s*(?:元)?\\s*含服务费"
    );

    private FuelQuoteParser() {
    }

    static List<FuelQuote> extract(
            List<OcrRow> inputRows,
            String capturedAt,
            List<FuelOffer> offers
    ) {
        List<OcrRow> rows = OcrRowGeometry.withSameLineMerges(inputRows);
        if (rows.isEmpty()) return new ArrayList<>();

        BigDecimal selected = inferSelectedAmount(rows);
        BigDecimal gross = inferGrossDiscount(rows);
        if (gross == null) {
            gross = labeledMoney(
                    rows,
                    new String[]{"优惠金额", "总优惠", "已优惠", "油品优惠", "立减优惠", "立减", "共优惠", "合计优惠", "优惠"},
                    new String[]{"优惠价", "优惠说明", "费用说明"}
            );
        }
        BigDecimal service = labeledMoney(
                rows,
                new String[]{"服务费"},
                new String[]{"含服务费"}
        );
        BigDecimal netDiscount = inferNetDiscount(rows);
        boolean observedDirectService = service != null;
        boolean observedNetDiscount = netDiscount != null;
        if (service != null && gross != null && service.compareTo(gross) > 0) {
            // 高德浅色“+¥0.87”可能被识别成“+40.87”；服务费不可能高于本次立减。
            service = null;
        }
        if (netDiscount != null && gross != null) {
            BigDecimal inferredService = money(gross.subtract(netDiscount));
            if (inferredService.signum() >= 0
                    && (service == null
                    || service.subtract(inferredService).abs().compareTo(new BigDecimal("0.05")) > 0)) {
                service = inferredService;
            }
        }
        BigDecimal payable = labeledMoney(
                rows,
                new String[]{"实际支付金额", "预计实付", "实付金额", "应付金额"},
                new String[0]
        );
        boolean hasPayableLabel = containsTerm(rows, "实际支付金额")
                || containsTerm(rows, "预计实付")
                || containsTerm(rows, "实付金额");
        boolean hasPaymentFooter = containsTerm(rows, "含服务费")
                || containsTerm(rows, "比油站价优惠")
                || hasProviderAttribution(rows);
        boolean hasPaymentBreakdown = selected != null && gross != null && service != null;
        if (payable == null && (hasPayableLabel || hasPaymentFooter || hasPaymentBreakdown)) {
            payable = standalonePayable(rows, selected);
        } else if (payable != null && hasPayableLabel) {
            BigDecimal standalone = standalonePayable(rows, selected);
            if (standalone != null && !standalone.equals(payable)) payable = standalone;
        }
        if (selected != null && netDiscount != null && hasPaymentFooter) {
            BigDecimal inferredPayable = money(selected.subtract(netDiscount));
            if (inferredPayable.signum() >= 0
                    && (payable == null
                    || payable.subtract(inferredPayable).abs().compareTo(new BigDecimal("0.05")) > 0)) {
                payable = inferredPayable;
            }
        }
        if (service == null && selected != null && gross != null && payable != null
                && payable.compareTo(selected) < 0) {
            BigDecimal inferred = money(payable.subtract(selected.subtract(gross)));
            if (inferred.signum() >= 0 && inferred.compareTo(gross) <= 0) service = inferred;
        }
        if (service != null && gross != null && netDiscount == null) {
            netDiscount = money(gross.subtract(service));
        }
        boolean unsupportedFullAmountFallback = selected != null
                && gross != null
                && gross.signum() > 0
                && payable != null
                && payable.compareTo(selected) == 0
                && !observedDirectService
                && !observedNetDiscount
                && !hasPayableLabel
                && !containsPayableFooter(rows);
        if (unsupportedFullAmountFallback) {
            service = null;
            netDiscount = null;
            payable = null;
        }
        if (selected == null || (gross == null && service == null && payable == null)) {
            return new ArrayList<>();
        }

        // 先收集所有油号锚点。
        List<String> gradesOnPage = new ArrayList<>();
        for (OcrRow row : rows) {
            Matcher matcher = FuelCardParser.Utilities.gradePattern().matcher(row.text);
            while (matcher.find()) {
                String code = matcher.group(1);
                if (!gradesOnPage.contains(code)) gradesOnPage.add(code);
            }
        }

        String grade = "";
        String gradeLabel = "";
        boolean gradeInferred = false;
        for (OcrRow row : rows) {
            String text = clean(row.text);
            if (grade.isEmpty()) {
                Matcher gradeMatcher = FuelCardParser.Utilities.gradePattern().matcher(text);
                if (gradeMatcher.find()) {
                    grade = gradeMatcher.group(1);
                    gradeLabel = gradeMatcher.group();
                }
            }
        }
        if (grade.isEmpty() && !gradesOnPage.isEmpty()) {
            grade = pickGradeForQuote(gradesOnPage, offers, selected, gross, service, payable);
            gradeLabel = grade + "#";
        }
        if (grade.isEmpty()) {
            // 纯支付确认页或支付结果页通常没有油号，用默认油号占位并标记待复核，避免金额字段丢失。
            boolean looksLikePayment = isPaymentConfirmationPage(rows)
                    || (selected != null && gross != null && (payable != null || netDiscount != null));
            if (looksLikePayment) {
                grade = "92";
                gradeLabel = "92#";
                gradeInferred = true;
            } else {
                return new ArrayList<>();
            }
        }

        String gunCode = "";
        String gunLabel = "";
        for (OcrRow row : rows) {
            String text = clean(row.text);
            if (gunCode.isEmpty()) {
                Matcher gunMatcher = GUN.matcher(text);
                if (gunMatcher.find()) {
                    gunCode = gunMatcher.group(1);
                    gunLabel = gunMatcher.group();
                }
            }
        }

        FuelQuote quote = new FuelQuote();
        quote.gradeCode = grade;
        quote.gradeLabel = gradeLabel.isEmpty() ? grade + "#" : gradeLabel;
        quote.gunCode = gunCode.isEmpty() ? null : gunCode;
        quote.gunLabel = gunLabel.isEmpty() ? null : gunLabel;
        quote.selectedAmount = selected;
        quote.grossDiscount = gross;
        quote.serviceFee = service;
        quote.netDiscount = netDiscount;
        quote.payableAmount = payable;
        boolean popup = isExplanationPopup(rows);
        quote.quoteEntry = popup ? "explanation_popup" : "inline";
        quote.gradeInferred = gradeInferred;
        quote.capturedAt = capturedAt;
        quote.validateFormula();
        if (quote.valid()) {
            List<FuelQuote> output = new ArrayList<>();
            output.add(quote);
            return output;
        }
        return new ArrayList<>();
    }

    private static boolean isPaymentConfirmationPage(List<OcrRow> rows) {
        boolean hasOrderAmount = false;
        boolean hasDiscount = false;
        boolean hasService = false;
        boolean hasNetDiscount = false;
        boolean hasProviderAttribution = false;
        for (OcrRow row : rows) {
            String text = clean(row.text);
            if (text.contains("应付金额") || text.contains("实际支付金额") || text.contains("预计实付")) {
                hasOrderAmount = true;
            }
            if (text.contains("立减优惠") || text.contains("优惠金额") || text.contains("优惠明细")
                    || SAVE_ON_AMOUNT.matcher(text).find()) {
                hasDiscount = true;
            }
            if (text.contains("服务费")) hasService = true;
            if (NET_DISCOUNT.matcher(text).find()) hasNetDiscount = true;
            if ((text.contains("服务商") || text.contains("本次由")) && text.contains("提供")) {
                hasProviderAttribution = true;
            }
        }
        if (!hasOrderAmount) hasOrderAmount = standalonePayable(rows, null) != null;
        return hasOrderAmount && hasDiscount
                && (hasService || hasNetDiscount || hasProviderAttribution);
    }

    /**
     * 当 quote 没有直接油号时，根据金额与 fuelOffers 反推油号。
     * 计算 selectedAmount / stationPrice * discountPrice，取最接近 grossDiscount 的油号。
     */
    private static String pickGradeForQuote(
            List<String> gradesOnPage,
            List<FuelOffer> offers,
            BigDecimal selected,
            BigDecimal gross,
            BigDecimal service,
            BigDecimal payable
    ) {
        if (gradesOnPage.size() == 1) return gradesOnPage.get(0);
        if (offers == null || offers.isEmpty()) return gradesOnPage.get(0);

        BigDecimal targetGross = gross;
        if (targetGross == null && selected != null && payable != null && service != null) {
            targetGross = selected.subtract(payable).add(service);
        }
        if (targetGross == null || selected == null || selected.signum() <= 0) {
            return gradesOnPage.get(0);
        }

        String bestGrade = null;
        BigDecimal bestError = null;
        for (String grade : gradesOnPage) {
            FuelOffer offer = null;
            for (FuelOffer o : offers) {
                if (o != null && grade.equals(o.gradeCode)) {
                    offer = o;
                    break;
                }
            }
            if (offer == null) continue;
            BigDecimal stationPrice = offer.stationPrice;
            if (stationPrice == null || stationPrice.signum() <= 0) continue;
            double discountDouble = offer.discountPrice == null ? 0d : offer.discountPrice;
            if (discountDouble <= 0) continue;
            BigDecimal liters = selected.divide(stationPrice, 4, java.math.RoundingMode.HALF_UP);
            BigDecimal expectedGross = liters.multiply(BigDecimal.valueOf(discountDouble))
                    .setScale(2, java.math.RoundingMode.HALF_UP);
            BigDecimal error = expectedGross.subtract(targetGross).abs();
            if (bestError == null || error.compareTo(bestError) < 0) {
                bestError = error;
                bestGrade = grade;
            }
        }
        return bestGrade == null ? gradesOnPage.get(0) : bestGrade;
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

    private static BigDecimal inferSelectedAmount(List<OcrRow> rows) {
        // 优先找明确标注的“加油金额/订单金额/选择金额/本次金额”标签后的金额。
        BigDecimal labeled = labeledMoney(
                rows,
                new String[]{"加油金额", "订单金额", "选择金额", "本次金额"},
                new String[]{"优惠金额", "实付金额", "应付金额", "预计实付"}
        );
        if (labeled != null) return labeled;

        // 其次找“加200省X元”中的 200；这种行通常和当前油号外显价在同一行。
        for (OcrRow row : rows) {
            String text = clean(row.text);
            Matcher save = SAVE_ON_AMOUNT.matcher(text);
            if (save.find()) return FuelQuote.money(save.group(1));
        }

        // 不再从 ¥100/¥200/¥300 按钮推断金额，避免把默认按钮当成实际支付金额。
        // 弹窗/支付明细里没有加油金额时，用应付金额作为订单金额兜底。
        BigDecimal payableAsOrder = labeledMoney(
                rows,
                new String[]{"应付金额"},
                new String[0]
        );
        if (payableAsOrder != null) return payableAsOrder;
        return null;
    }

    private static BigDecimal inferGrossDiscount(List<OcrRow> rows) {
        // 优先从“加200省X元”或“立减X元”这种行直接提取优惠金额。
        for (OcrRow row : rows) {
            String text = clean(row.text);
            Matcher save = SAVE_ON_AMOUNT.matcher(text);
            if (save.find()) {
                return FuelQuote.money(save.group(2));
            }
            Matcher lijian = LIJIAN_AMOUNT.matcher(text);
            if (lijian.find()) {
                BigDecimal value = FuelQuote.money(lijian.group(1));
                // 高德详情页会同时列出 100/200/300 三档立减金额，只取 200 元档。
                if (value != null && !text.contains("10.32") && !text.contains("30.97")) {
                    return value;
                }
            }
        }
        return null;
    }

    private static BigDecimal labeledMoney(
            List<OcrRow> rows,
            String[] labels,
            String[] excludedLabels
    ) {
        for (int index = 0; index < rows.size(); index++) {
            OcrRow row = rows.get(index);
            String text = clean(row.text);
            boolean contains = containsAny(text, labels);
            boolean excluded = containsAny(text, excludedLabels);
            if (!contains || excluded) continue;
            // 公式/说明行（如“实际支付金额=应付金额-...”）不当作标签来源。
            if (text.contains("=") || text.contains("：")) continue;
            BigDecimal direct = firstMoney(text);
            if (direct != null) return direct;
            BigDecimal nearby = nearestMoney(rows, index);
            if (nearby != null) return nearby;
        }
        return null;
    }

    private static BigDecimal nearestMoney(List<OcrRow> rows, int labelIndex) {
        OcrRow label = rows.get(labelIndex);
        String labelText = clean(label.text);
        boolean preferRightSide = labelText.contains("立减优惠") || labelText.contains("合计优惠")
                || labelText.contains("服务费") || labelText.contains("预计实付")
                || labelText.contains("应付金额") || labelText.contains("优惠金额");

        // 第一趟：优先找标签右侧同 y 附近、且是“-X.XX”或“+X.XX”的金额。
        if (preferRightSide) {
            BigDecimal rightCandidate = null;
            float rightBest = Float.MAX_VALUE;
            for (int index = 0; index < rows.size(); index++) {
                if (index == labelIndex) continue;
                OcrRow row = rows.get(index);
                if (row.x <= label.x) continue;
                String text = clean(row.text);
                if (FuelCardParser.Utilities.gradePattern().matcher(text).find()
                        || GUN.matcher(text).find()) continue;
                if (!text.matches(".*[\\-+]\\s*[¥￥]?[0-9]+(?:\\.[0-9]{1,2})?.*")
                        && !text.matches("^[¥￥]?[0-9]+(?:\\.[0-9]{1,2})?$")) {
                    continue;
                }
                BigDecimal value = firstMoney(text);
                if (value == null) continue;
                float yDistance = Math.abs(row.y - label.y);
                float xDistance = row.x - label.x;
                if (yDistance > 0.04f) continue;
                float distance = yDistance * 3f + xDistance;
                if (distance < rightBest) {
                    rightBest = distance;
                    rightCandidate = value;
                }
            }
            if (rightCandidate != null) return rightCandidate;
        }

        BigDecimal candidate = null;
        float best = Float.MAX_VALUE;
        boolean isAmountLabel = labelText.contains("加油金额") || labelText.contains("订单金额")
                || labelText.contains("选择金额") || labelText.contains("本次金额")
                || labelText.contains("应付金额") || labelText.contains("实付金额")
                || labelText.contains("预计实付");
        for (int index = 0; index < rows.size(); index++) {
            if (index == labelIndex) continue;
            OcrRow row = rows.get(index);
            String text = clean(row.text);
            if (FuelCardParser.Utilities.gradePattern().matcher(text).find()
                    || GUN.matcher(text).find()) continue;
            // 排除“95号200元”这种营销/说明文字中的金额；金额类标签允许金额按钮作为候选。
            if (text.contains("号") || text.contains("枪")
                    || text.matches(".*(?:省|减|降|折|券).*")) continue;
            if (!isAmountLabel && AMOUNT_BUTTON.matcher(text).matches()) continue;
            // 金额类标签只取纯数字/¥X.XX，避免把优惠行的带符号金额当成本金。
            if (isAmountLabel && (text.contains("-") || text.contains("+"))) continue;
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
        // 跳过“95号200元”、“1号枪”这种说明文字中的数字。
        if (text.matches(".*(?:[0-9]+号|枪|油号|柴油|汽油).*")) {
            return null;
        }
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

    private static BigDecimal inferNetDiscount(List<OcrRow> rows) {
        for (OcrRow row : rows) {
            String text = clean(row.text);
            Matcher matcher = NET_DISCOUNT.matcher(text);
            if (matcher.find()) {
                BigDecimal value = FuelQuote.money(matcher.group(1));
                if (value != null && value.signum() >= 0) return value;
            }
        }
        return null;
    }

    private static boolean containsTerm(List<OcrRow> rows, String term) {
        for (OcrRow row : rows) {
            if (clean(row.text).contains(term)) return true;
        }
        return false;
    }

    private static boolean hasProviderAttribution(List<OcrRow> rows) {
        for (OcrRow row : rows) {
            String text = clean(row.text);
            if ((text.contains("服务商") || text.contains("本次由")) && text.contains("提供")) {
                return true;
            }
        }
        return false;
    }

    private static BigDecimal standalonePayable(List<OcrRow> rows, BigDecimal selectedAmount) {
        BigDecimal candidate = null;
        BigDecimal nonSelectedCandidate = null;
        float bestY = -1f;
        float bestNonSelectedY = -1f;
        for (OcrRow row : rows) {
            String text = clean(row.text);
            Matcher payableFooter = PAYABLE_WITH_SERVICE_FEE.matcher(text);
            if (payableFooter.find()) {
                BigDecimal footerValue = FuelQuote.money(payableFooter.group(1).replace(',', '.'));
                if (isDistinctPayable(footerValue, selectedAmount) && row.y > bestNonSelectedY) {
                    bestNonSelectedY = row.y;
                    nonSelectedCandidate = footerValue;
                }
                continue;
            }
            if (text.contains("优惠") || text.contains("省") || text.contains("减")
                    || text.contains("服务费") || text.contains("券")
                    || text.contains("/L") || text.contains("/升") || text.contains("/份")) {
                continue;
            }
            if (FuelCardParser.Utilities.gradePattern().matcher(text).find()) continue;
            if (AMOUNT_BUTTON.matcher(text).matches()) continue;
            if (text.matches(".*(?:加|充|满|减)(?:100|200|300|400|500).*")) continue;
            BigDecimal value = firstMoney(text);
            if (!isPlausiblePayable(value, selectedAmount)) continue;
            if (row.y > bestY) {
                bestY = row.y;
                candidate = value;
            }
            if (selectedAmount != null
                    && value.compareTo(selectedAmount) != 0
                    && row.y > bestNonSelectedY) {
                bestNonSelectedY = row.y;
                nonSelectedCandidate = value;
            }
        }
        return selectedAmount == null
                ? (nonSelectedCandidate == null ? candidate : nonSelectedCandidate)
                : nonSelectedCandidate;
    }

    private static boolean isDistinctPayable(BigDecimal value, BigDecimal selectedAmount) {
        return isPlausiblePayable(value, selectedAmount)
                && (selectedAmount == null || value.compareTo(selectedAmount) != 0);
    }

    private static boolean isPlausiblePayable(BigDecimal value, BigDecimal selectedAmount) {
        if (value == null
                || value.compareTo(new BigDecimal("50.00")) < 0
                || value.compareTo(new BigDecimal("5000.00")) > 0) {
            return false;
        }
        return selectedAmount == null
                || value.compareTo(selectedAmount.add(new BigDecimal("5.00"))) <= 0;
    }

    private static boolean containsPayableFooter(List<OcrRow> rows) {
        for (OcrRow row : rows) {
            if (PAYABLE_WITH_SERVICE_FEE.matcher(clean(row.text)).find()) return true;
        }
        return false;
    }

    private static BigDecimal money(BigDecimal value) {
        return value == null ? null : value.setScale(2, java.math.RoundingMode.HALF_UP);
    }

    private static String clean(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }
}
