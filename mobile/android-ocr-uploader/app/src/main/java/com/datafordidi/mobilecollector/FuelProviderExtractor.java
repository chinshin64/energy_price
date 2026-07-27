package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 燃油服务商归属解析器。
 */
final class FuelProviderExtractor {

    private static final Pattern PROVIDER_LABEL = Pattern.compile(
            "(?:CP|cp|服务提供方|服务商)\\s*[:：]\\s*([\\u4e00-\\u9fa5A-Za-z0-9（）()·\\-]{2,40})"
    );
    private static final Pattern PROVIDED_BY = Pattern.compile(
            "(?:本次(?:油)?|本服务)?由\\s*(?:服务商)?\\s*[\"“”‘’']?\\s*"
                    + "([\\u4e00-\\u9fa5A-Za-z0-9（）()·\\-]{2,40})\\s*[\"“”‘’']?\\s*提供"
    );
    private static final Pattern SERVICE_PROVIDER = Pattern.compile(
            "(?:本次(?:油)?|本服务)服务商\\s*[:：]?\\s*"
                    + "([\\u4e00-\\u9fa5A-Za-z0-9（）()·\\-]{2,40})\\s*提供"
    );

    private FuelProviderExtractor() {
    }

    static Result extract(List<OcrRow> rows) {
        if (rows == null || rows.isEmpty()) return Result.empty();
        for (OcrRow row : OcrRowGeometry.withSameLineMerges(rows)) {
            String text = clean(row.text);
            Matcher serviceProvider = SERVICE_PROVIDER.matcher(text);
            Matcher explicit = PROVIDER_LABEL.matcher(text);
            Matcher by = PROVIDED_BY.matcher(text);
            String name = serviceProvider.find() ? serviceProvider.group(1)
                    : explicit.find() ? explicit.group(1)
                    : by.find() ? by.group(1) : "";
            name = cleanProvider(name);
            name = normalizeKnownProvider(name, text);
            if (name.isEmpty() || "高德".equals(name) || "高德地图".equals(name)) continue;
            JSONObject evidence = new JSONObject();
            put(evidence, "kind", "provider-attribution");
            put(evidence, "text", name);
            JSONObject box = new JSONObject();
            put(box, "x", row.x);
            put(box, "y", row.y);
            put(box, "width", row.width);
            put(box, "height", row.height);
            put(evidence, "boundingBox", box);
            return new Result(name, evidence);
        }
        return Result.empty();
    }

    private static String cleanProvider(String value) {
        String output = clean(value)
                .replaceAll("(?:手机号|手机号码|联系电话|身份证|银行卡|验证码|短信码|"
                        + "订单(?:号|编号|ID|信息)?|支付(?:号|编号|ID|账户|账号|密码|凭证)|"
                        + "交易号|账号|账户|用户名|登录名|密码|口令).*$", "")
                .replaceAll("^(?:服务提供方|服务商|服(?:务)?商|CP|cp)[:：]?", "")
                .replaceAll("提供.*$", "")
                .replaceAll("(?:(?:提供)?服务|提供|服务商|CP|cp)$", "")
                .replaceAll("^[：:·•\\-]+|[：:·•\\-]+$", "");
        if (StationSensitiveDataPolicy.isSensitive(output)) return "";
        return output.length() <= 40 ? output : output.substring(0, 40);
    }

    private static String normalizeKnownProvider(String provider, String sourceText) {
        String name = clean(provider);
        String evidence = clean(sourceText);
        for (String known : new String[]{"滴滴加油", "团油", "易加油"}) {
            if (name.contains(known)) return known;
        }
        boolean attribution = (evidence.contains("服务商") || evidence.contains("本次由"))
                && evidence.contains("提供");
        if (attribution && "滴加油".equals(name)) return "滴滴加油";
        return name;
    }

    private static String clean(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化燃油服务商证据", error);
        }
    }

    static final class Result {
        final String name;
        final JSONObject evidence;

        Result(String name, JSONObject evidence) {
            this.name = name;
            this.evidence = evidence;
        }

        static Result empty() {
            return new Result(null, null);
        }

        boolean present() {
            return name != null && !name.isEmpty();
        }
    }
}
