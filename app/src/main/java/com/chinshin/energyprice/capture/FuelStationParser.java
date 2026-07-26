package com.chinshin.energyprice.capture;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class FuelStationParser {
    private static final String CURRENCY = "[¥￥#Yy]?";
    private static final Pattern GRADE = Pattern.compile("(?<!\\d)(92|95|98|0)\\s*[#号]?");
    private static final Pattern GRADE_DISCOUNT = Pattern.compile("(?<!\\d)(92|95)\\s*[#号]?.{0,16}?(?:优惠|每升省)\\s*" + CURRENCY + "\\s*(\\d+(?:\\.\\d{1,2})?)\\s*(?:元)?\\s*/?\\s*[Ll升]", Pattern.CASE_INSENSITIVE);
    private static final Pattern STATION_PRICE = Pattern.compile("(?:加油站价|油站价|挂牌价|国标价|站价|原价)\\s*[:：]?\\s*" + CURRENCY + "\\s*(\\d{1,2}(?:\\.\\d{1,3})?)\\s*(?:元)?\\s*/?\\s*[Ll升]?", Pattern.CASE_INSENSITIVE);
    private static final Pattern DISPLAY_PRICE = Pattern.compile("(?:外显价|优惠价|活动价|会员价|到手价)\\s*[:：]?\\s*" + CURRENCY + "\\s*(\\d{1,2}(?:\\.\\d{1,3})?)\\s*(?:元)?\\s*/?\\s*[Ll升]?", Pattern.CASE_INSENSITIVE);
    private static final Pattern PER_LITER_PRICE = Pattern.compile(CURRENCY + "\\s*(\\d{1,2}\\.\\d{1,3})\\s*(?:元)?\\s*/?\\s*[Ll升]", Pattern.CASE_INSENSITIVE);
    private static final Pattern SAVE_200 = Pattern.compile("200\\s*元?\\s*(?:约?省|立[减碱]|优惠)\\s*" + CURRENCY + "\\s*(\\d+(?:\\.\\d{1,2})?)");
    private static final Pattern DISCOUNT = Pattern.compile("(?:立[减碱](?:优惠)?|优惠金额|合计优惠|优惠券优惠|优惠)\\s*[:：]?\\s*[-−—]?\\s*" + CURRENCY + "\\s*[-−]?\\s*(\\d+(?:\\.\\d{1,2})?)");
    private static final Pattern SERVICE_FEE = Pattern.compile("服务费\\s*[:：]?\\s*[+＋]?\\s*" + CURRENCY + "\\s*(\\d+(?:\\.\\d{1,2})?)");
    private static final Pattern PAYABLE = Pattern.compile("(?:实付金额|应付金额|合计支付|立即支付|需支付|实付)\\s*[:：]?\\s*" + CURRENCY + "\\s*(\\d{2,3}(?:\\.\\d{1,2})?)");
    private static final Pattern PROVIDER_1 = Pattern.compile("(?:本次[^\\n]{0,12}?由(?:服务商)?|服务商\\s*[:：]?)\\s*([^，。；;:：\\s]{1,30}?)(?:提供|提洪|服务|$)");
    private static final Pattern PROVIDER_2 = Pattern.compile("由\\s*(?:服务商)?\\s*([^，。；;:：\\s]{1,30}?)\\s*(?:提供|提洪)");
    private static final Pattern BARE_PRICE = Pattern.compile("^" + CURRENCY + "\\s*(\\d{1,2}\\.\\d{1,3})\\s*(?:起)?$");
    private static final Pattern EXACT_200 = Pattern.compile("^(?:__SELECTED__\\s*)?" + CURRENCY + "\\s*200(?:\\.00)?\\s*(?:元)?$");

    private FuelStationParser() {}

    public static FuelCapture parse(List<String> inputLines, long capturedAtEpochMs) {
        List<String> lines = normalizeLines(inputLines);
        String joined = String.join("\n", lines);
        FuelCapture out = new FuelCapture();
        out.capturedAtEpochMs = capturedAtEpochMs;
        out.rawText = joined;
        out.screenHash = sha256(joined);
        out.paymentPage = containsAny(joined, "立即支付", "支付详情", "付款明细", "立减优惠", "立碱优惠", "服务费", "应付金额", "实付金额")
                || (joined.contains("服务商") && containsAny(joined, "提供", "提洪"));
        out.stationName = findStationName(lines);
        out.gradeCode = findGrade(lines);
        out.gradeExplicit = isGradeExplicit(lines, out.gradeCode);
        if (out.gradeCode != null) out.gradeLabel = out.gradeCode + "号汽油";
        out.amountYuan = findAmount(lines);
        out.stationPrice = findFirstDouble(STATION_PRICE, joined);
        out.listPrice = out.stationPrice;
        out.displayPrice = findFirstDouble(DISPLAY_PRICE, joined);
        out.discountPerLiter = findGradeDiscount(lines, out.gradeCode);
        out.discountAmount = findDiscount(joined);
        out.serviceFee = findFirstDouble(SERVICE_FEE, joined);
        out.payableAmount = findFirstDouble(PAYABLE, joined);

        if (out.displayPrice == null) {
            out.displayPrice = findContextDisplayPrice(lines, out.gradeCode);
        }
        if (out.stationPrice == null && out.displayPrice != null && out.discountPerLiter != null) {
            out.stationPrice = round3(out.displayPrice + out.discountPerLiter);
            out.listPrice = out.stationPrice;
        }
        if (out.paymentPage) {
            Provider provider = findProvider(lines);
            if (provider != null) {
                out.providerName = provider.name;
                out.providerEvidenceText = provider.evidence;
            }
        }
        return out;
    }

    static List<String> normalizeLines(List<String> source) {
        List<String> out = new ArrayList<>();
        if (source == null) return out;
        for (String raw : source) {
            if (raw == null) continue;
            String selectedPrefix = raw.startsWith("__SELECTED__") ? "__SELECTED__ " : "";
            String value = raw.replace("__SELECTED__", "")
                    .replace('\u00A0', ' ')
                    .replace('＃', '#')
                    .replace('￥', '¥')
                    .replaceAll("[\\t\\r]+", " ")
                    .replaceAll(" {2,}", " ")
                    .trim();
            if (!value.isEmpty()) out.add(selectedPrefix + value);
        }
        return out;
    }

    private static String findStationName(List<String> lines) {
        return lines.stream()
                .map(FuelStationParser::stripSelected)
                .map(FuelStationParser::sanitizeStationTitle)
                .filter(FuelStationParser::looksLikeStationTitle)
                .max(Comparator.comparingInt(FuelStationParser::stationTitleScore))
                .orElse(null);
    }

    private static String sanitizeStationTitle(String value) {
        return value
                .replaceAll("(?:刚刚浏览|刚浏览|位置好找|距您|导航|评价).*$", "")
                .replaceAll("^[·•|丨\\s]+|[·•|丨\\s]+$", "")
                .trim();
    }

    private static boolean looksLikeStationTitle(String line) {
        if (line.length() < 4 || line.length() > 80) return false;
        if (containsAny(line, "有效", "可用", "优惠券", "领券", "券", "附近", "服务费", "支付", "约省")) return false;
        return line.contains("加油站") || line.endsWith("油站") || line.endsWith("供能站") || line.endsWith("能源站");
    }

    private static int stationTitleScore(String line) {
        int score = Math.min(line.length(), 40);
        if (line.contains("加油站")) score += 30;
        if (line.contains("有限公司")) score -= 10;
        return score;
    }

    private static String findGrade(List<String> lines) {
        for (String line : lines) {
            if (!line.startsWith("__SELECTED__")) continue;
            Matcher matcher = GRADE.matcher(line);
            if (matcher.find()) return matcher.group(1);
        }
        for (String line : lines) {
            Matcher matcher = GRADE_DISCOUNT.matcher(line);
            if (matcher.find()) return matcher.group(1);
        }
        for (String line : lines) {
            if (!containsAny(line, "优惠", "外显价", "200元省", "当前油号", "已选")) continue;
            Matcher matcher = GRADE.matcher(line);
            if (matcher.find()) return matcher.group(1);
        }
        for (String line : lines) {
            Matcher matcher = GRADE.matcher(line);
            if (matcher.find()) return matcher.group(1);
        }
        return null;
    }

    private static boolean isGradeExplicit(List<String> lines, String gradeCode) {
        if (gradeCode == null) return false;
        for (String line : lines) {
            Matcher matcher = GRADE.matcher(line);
            if (!matcher.find() || !gradeCode.equals(matcher.group(1))) continue;
            if (line.startsWith("__SELECTED__") || GRADE_DISCOUNT.matcher(line).find()
                    || containsAny(line, "优惠", "外显价", "200元省", "当前油号", "已选")) return true;
        }
        return false;
    }

    private static Integer findAmount(List<String> lines) {
        for (String line : lines) {
            if (line.startsWith("__SELECTED__") && line.matches(".*[¥￥#Yy]?\\s*200(?:\\.00)?(?:元)?.*")) return 200;
        }
        for (String line : lines) {
            if (EXACT_200.matcher(line).matches()) return 200;
            if (line.matches(".*(?:油费金额|加油金额|订单金额).*?[¥￥#Yy]?\\s*200(?:\\.00)?.*")) return 200;
            if (line.matches(".*200\\s*元\\s*(?:约?省|立[减碱]|优惠).*")) return 200;
        }
        return null;
    }

    private static Double findGradeDiscount(List<String> lines, String gradeCode) {
        for (String line : lines) {
            Matcher matcher = GRADE_DISCOUNT.matcher(line);
            while (matcher.find()) {
                if (gradeCode == null || gradeCode.equals(matcher.group(1))) return parseDouble(matcher.group(2));
            }
        }
        return null;
    }

    private static Double findDiscount(String joined) {
        Matcher save = SAVE_200.matcher(joined);
        if (save.find()) return parseDouble(save.group(1));
        return findFirstDouble(DISCOUNT, joined);
    }

    private static Double findContextDisplayPrice(List<String> lines, String gradeCode) {
        for (String line : lines) {
            String plain = stripSelected(line);
            if (containsAny(plain, "油站价", "加油站价", "挂牌价", "原价", "站价")) continue;
            boolean useful = containsAny(plain, "外显", "优惠", "200元省", "元/L", "/L", "元/升");
            if (!useful) continue;
            if (gradeCode != null && GRADE.matcher(plain).find() && !plain.contains(gradeCode)) continue;
            Matcher matcher = PER_LITER_PRICE.matcher(plain);
            if (matcher.find()) {
                Double value = parseDouble(matcher.group(1));
                if (validFuelPrice(value)) return value;
            }
        }
        for (String line : lines) {
            if (containsAny(line, "油站价", "加油站价", "挂牌价", "原价", "站价")) continue;
            Matcher matcher = PER_LITER_PRICE.matcher(line);
            if (matcher.find()) {
                Double value = parseDouble(matcher.group(1));
                if (validFuelPrice(value)) return value;
            }
        }
        for (String line : lines) {
            if (containsAny(line, "油站价", "加油站价", "挂牌价", "原价", "站价")) continue;
            Matcher matcher = BARE_PRICE.matcher(stripSelected(line));
            if (matcher.matches()) {
                Double value = parseDouble(matcher.group(1));
                if (validFuelPrice(value)) return value;
            }
        }
        return null;
    }

    private static Provider findProvider(List<String> lines) {
        for (String line : lines) {
            String plain = stripSelected(line);
            if (!containsAny(plain, "服务商", "本次由", "本次服务由", "提供", "提洪")) continue;
            String canonical = canonicalProvider(plain);
            if (canonical != null) return new Provider(canonical, plain);
            Matcher m1 = PROVIDER_1.matcher(plain);
            if (m1.find()) {
                String name = cleanProvider(m1.group(1));
                if (isValidProvider(name)) return new Provider(name, plain);
            }
            Matcher m2 = PROVIDER_2.matcher(plain);
            if (m2.find()) {
                String name = cleanProvider(m2.group(1));
                if (isValidProvider(name)) return new Provider(name, plain);
            }
        }
        return null;
    }

    static String cleanProvider(String raw) {
        if (raw == null) return null;
        String canonical = canonicalProvider(raw);
        if (canonical != null) return canonical;
        return raw
                .replaceAll("^.*?(?:本次服务由|本次由|服务商)\\s*[:：]?", "")
                .replaceAll("(?:提供|提洪).*$", "")
                .replaceAll("(?:服务|平台)$", "")
                .replaceAll("^[：:，,。\\s]+|[：:，,。Oo0\\s]+$", "")
                .trim();
    }

    static String canonicalProvider(String raw) {
        if (raw == null) return null;
        String compact = raw.replaceAll("[\\s：:，,。|丨]", "")
                .replace('由', '由');
        if (compact.contains("团油")) return "团油";
        if (compact.contains("易加油") || compact.contains("易加由") || compact.contains("易加袖")) return "易加油";
        if (compact.contains("滴滴加油") || compact.contains("滴加油")
                || compact.contains("滴滴加由") || compact.contains("滴滴加袖")) return "滴滴加油";
        return null;
    }

    private static boolean isValidProvider(String value) {
        return value != null && value.length() >= 2 && value.length() <= 30
                && !containsAny(value, "优惠", "服务费", "支付", "高德地图", "详情", "金额");
    }

    private static Double findFirstDouble(Pattern pattern, String text) {
        Matcher matcher = pattern.matcher(text);
        if (!matcher.find()) return null;
        return parseDouble(matcher.group(1));
    }

    private static Double parseDouble(String raw) {
        try {
            return Double.parseDouble(raw.replace(',', '.'));
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean validFuelPrice(Double value) {
        return value != null && value >= 4d && value <= 15d;
    }

    private static String stripSelected(String value) {
        return value.replace("__SELECTED__", "").trim();
    }

    private static boolean containsAny(String value, String... tokens) {
        for (String token : tokens) if (value.contains(token)) return true;
        return false;
    }

    private static double round3(double value) {
        return Math.round(value * 1000d) / 1000d;
    }

    public static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (byte b : bytes) out.append(String.format(Locale.US, "%02x", b));
            return out.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static final class Provider {
        final String name;
        final String evidence;

        Provider(String name, String evidence) {
            this.name = name;
            this.evidence = evidence;
        }
    }
}
