package com.chinshin.energyprice.capture;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Rules shared by the two-stage detail/payment capture flow. */
public final class FuelCaptureRules {
    private static final String CURRENCY = "[¥￥#Yy]?";
    private static final Pattern ADD_200_DISCOUNT = Pattern.compile(
            "(?:加\\s*)?200\\s*(?:元)?\\s*(?:约?省|立[减碱](?:优惠)?|优惠)\\s*" + CURRENCY + "\\s*(\\d+(?:\\.\\d{1,2})?)"
    );
    private static final Pattern PAYABLE_WITH_FEE = Pattern.compile(
            CURRENCY + "\\s*(1\\d{2}(?:\\.\\d{1,2})?)\\s*(?:含服务费|立即支付)"
    );
    private static final Pattern NET_DISCOUNT = Pattern.compile(
            "比(?:油站价|加油站价)优惠\\s*" + CURRENCY + "\\s*(\\d+(?:\\.\\d{1,2})?)"
    );
    private static final Pattern PER_LITER = Pattern.compile(
            CURRENCY + "\\s*(\\d{1,2}\\.\\d{1,3})\\s*(?:元)?\\s*/\\s*[Ll升]",
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern VISUAL_GRADE = Pattern.compile("__SELECTED__\\s*(92|95)\\s*[#号]?");

    private FuelCaptureRules() {}

    public static void prepareDetail(FuelCapture capture) {
        if (capture == null) return;
        // Payment-page values must replace promotional estimates from the detail page.
        capture.discountAmount = null;
        capture.serviceFee = null;
        capture.payableAmount = null;
        capture.providerName = null;
        capture.providerEvidenceText = null;
        capture.paymentPage = false;

        String visuallySelected = visuallySelectedGrade(capture.rawText);
        if (visuallySelected == null) {
            // Grade-discount rows often contain both 92 and 95. They are not selection evidence.
            capture.gradeCode = null;
            capture.gradeLabel = null;
            capture.gradeExplicit = false;
        } else {
            capture.gradeCode = visuallySelected;
            capture.gradeLabel = visuallySelected + "号汽油";
            capture.gradeExplicit = true;
        }
    }

    public static void preparePayment(FuelCapture capture) {
        if (capture == null) return;
        String raw = capture.rawText == null ? "" : capture.rawText;
        capture.paymentPage = true;
        capture.amountYuan = 200;

        if (capture.displayPrice == null) {
            capture.displayPrice = firstDouble(PER_LITER, raw);
        }
        Double grossDiscount = firstDouble(ADD_200_DISCOUNT, raw);
        if (grossDiscount != null) capture.discountAmount = grossDiscount;

        if (capture.payableAmount == null) {
            capture.payableAmount = firstDouble(PAYABLE_WITH_FEE, raw);
        }

        Double derivedFee = deriveServiceFee(capture.amountYuan, capture.discountAmount, capture.payableAmount);
        if (derivedFee != null) capture.serviceFee = derivedFee;

        String visuallySelected = visuallySelectedGrade(raw);
        if (visuallySelected == null) {
            // Payment pages do not normally show a grade. Ignore numeric false positives.
            capture.gradeCode = null;
            capture.gradeLabel = null;
            capture.gradeExplicit = false;
        } else {
            capture.gradeCode = visuallySelected;
            capture.gradeLabel = visuallySelected + "号汽油";
            capture.gradeExplicit = true;
        }
    }

    public static Double deriveServiceFee(Integer amountYuan, Double grossDiscount, Double payableAmount) {
        if (amountYuan == null || grossDiscount == null || payableAmount == null) return null;
        double fee = payableAmount - (amountYuan - grossDiscount);
        fee = round2(fee);
        if (fee < -0.01d || fee > 30d) return null;
        return Math.max(0d, fee);
    }

    public static Double parseNetDiscount(String rawText) {
        return firstDouble(NET_DISCOUNT, rawText == null ? "" : rawText);
    }

    public static boolean paymentMathIsConsistent(FuelCapture capture) {
        if (capture == null || capture.amountYuan == null || capture.discountAmount == null
                || capture.serviceFee == null || capture.payableAmount == null) return false;
        double expected = capture.amountYuan - capture.discountAmount + capture.serviceFee;
        return Math.abs(expected - capture.payableAmount) <= 0.03d;
    }

    public static String normalizeStationName(String value) {
        if (value == null) return "";
        return value.replaceAll("[\\s·•|丨，,。()（）\\-]", "")
                .replace("加油站加油站", "加油站")
                .trim();
    }

    public static String priceKey(Double displayPrice) {
        return displayPrice == null ? "unknown" : String.format(Locale.US, "%.2f", displayPrice);
    }

    static String visuallySelectedGrade(String rawText) {
        Matcher matcher = VISUAL_GRADE.matcher(rawText == null ? "" : rawText);
        return matcher.find() ? matcher.group(1) : null;
    }

    private static Double firstDouble(Pattern pattern, String input) {
        Matcher matcher = pattern.matcher(input == null ? "" : input);
        if (!matcher.find()) return null;
        try {
            return Double.parseDouble(matcher.group(1));
        } catch (Exception ignored) {
            return null;
        }
    }

    private static double round2(double value) {
        return Math.round(value * 100d) / 100d;
    }
}
