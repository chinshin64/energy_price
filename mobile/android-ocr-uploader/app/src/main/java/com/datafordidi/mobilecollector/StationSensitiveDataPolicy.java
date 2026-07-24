package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Iterator;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Rejects high-confidence personal/account data without stripping normal station addresses.
 */
final class StationSensitiveDataPolicy {
    private static final Pattern SENSITIVE_LABEL = Pattern.compile(
            "(?:手机号|手机号码|联系电话|身份证(?:号|号码)?|银行卡(?:号|号码)?|"
                    + "验证码|短信码|订单(?:号|编号|ID|信息)?|"
                    + "支付(?:号|编号|ID|账户|账号|密码|凭证)|"
                    + "交易号|账号|账户|用户名|登录名|密码|口令)",
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern ENGLISH_SENSITIVE_LABEL = Pattern.compile(
            "(?i)(?:phone|mobile|id\\s*card|identity\\s*card|bank\\s*card|"
                    + "account|password|verification\\s*code|order\\s*id|payment\\s*id)"
                    + "\\s*[:：=]"
    );
    private static final Pattern PHONE = Pattern.compile("(?<!\\d)1[3-9]\\d{9}(?!\\d)");
    private static final Pattern ID_CARD = Pattern.compile(
            "(?<![0-9A-Za-z])(?:\\d{17}[0-9Xx]|\\d{15})(?![0-9A-Za-z])"
    );
    private static final Pattern BANK_CARD = Pattern.compile(
            "(?<!\\d)(?:\\d[ -]?){15,18}\\d(?!\\d)"
    );
    private static final Pattern BEARER = Pattern.compile(
            "(?i)(?:^|\\s)Bearer\\s+[A-Za-z0-9._~+/\\-]{8,}=*"
    );
    private static final Pattern JWT = Pattern.compile(
            "(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}"
                    + "\\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])"
    );
    private static final Pattern ASSIGNED_CREDENTIAL = Pattern.compile(
            "(?i)(?<![A-Za-z0-9_])(?:access[_-]?token|api[_-]?key|token|secret|password)"
                    + "(?![A-Za-z0-9_])\\s*[:=]\\s*"
                    + "(?:\"[^\"\\r\\n]{6,}\"|'[^'\\r\\n]{6,}'|[A-Za-z0-9._~+/=-]{8,})"
    );
    private static final Pattern STRICT_HASH = Pattern.compile("(?i)[a-f0-9]{12,128}");
    private static final Pattern UUID_TOKEN = Pattern.compile(
            "(?i)(?<![0-9a-f])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![0-9a-f])"
    );
    private static final Pattern EMBEDDED_HEX_TOKEN = Pattern.compile(
            "(?i)(?<![0-9a-f])(?=[0-9a-f]{12,128}(?![0-9a-f]))"
                    + "(?=[0-9a-f]*[a-f])[0-9a-f]{12,128}(?![0-9a-f])"
    );
    private static final Pattern CONTROLLED_TECHNICAL = Pattern.compile("[A-Za-z0-9._/\\-]{1,100}");

    private StationSensitiveDataPolicy() {
    }

    static void requireSafeField(String fieldName, String value) {
        if (!isSensitive(value)) return;
        String label = "stationName".equals(fieldName) ? "场站名称" : "场站地址";
        throw new IllegalArgumentException(label + "包含不可回传的敏感信息");
    }

    static boolean isSensitive(String value) {
        String text = value == null ? "" : value.replaceAll("[\\r\\n\\t]+", " ").trim();
        return !text.isEmpty() && (SENSITIVE_LABEL.matcher(text).find()
                || ENGLISH_SENSITIVE_LABEL.matcher(text).find()
                || PHONE.matcher(text).find()
                || ID_CARD.matcher(text).find()
                || BANK_CARD.matcher(text).find()
                || BEARER.matcher(text).find()
                || JWT.matcher(text).find()
                || ASSIGNED_CREDENTIAL.matcher(text).find());
    }

    static void requireSafeUserDerived(Object value) {
        if (AddressFreePayload.containsSensitiveKey(value)) {
            throw new IllegalArgumentException("用户派生文本触发敏感字段安全拒绝");
        }
        requireSafeValue(value, "");
    }

    static void requireSafeBatch(JSONObject batch) {
        if (batch == null) throw new IllegalArgumentException("回传批次为空");
        requireSafeUserDerived(batch);
    }

    static void requireSafePayload(JSONObject payload) {
        requireSafeBatch(payload);
    }

    private static void requireSafeValue(Object value, String key) {
        if (value == null || value == JSONObject.NULL || value instanceof Number
                || value instanceof Boolean) {
            return;
        }
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String childKey = keys.next();
                requireSafeValue(object.opt(childKey), childKey);
            }
            return;
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int index = 0; index < array.length(); index++) {
                requireSafeValue(array.opt(index), key);
            }
            return;
        }
        String text = String.valueOf(value).replaceAll("[\\r\\n\\t]+", " ").trim();
        if (text.isEmpty()) return;
        if (BEARER.matcher(text).find()
                || JWT.matcher(text).find()
                || ASSIGNED_CREDENTIAL.matcher(text).find()) {
            throw new IllegalArgumentException("用户派生文本触发凭据安全拒绝");
        }
        if (isStrictTechnicalValue(key, text)) return;
        String scanned = scrubGeneratedTechnicalTokens(key, text);
        if (SENSITIVE_LABEL.matcher(scanned).find()
                || ENGLISH_SENSITIVE_LABEL.matcher(scanned).find()) {
            throw new IllegalArgumentException("用户派生文本触发敏感标签安全拒绝");
        }
        if (PHONE.matcher(scanned).find()) {
            throw new IllegalArgumentException("用户派生文本触发联系方式安全拒绝");
        }
        if (ID_CARD.matcher(scanned).find()) {
            throw new IllegalArgumentException("用户派生文本触发身份标识安全拒绝");
        }
        if (BANK_CARD.matcher(scanned).find()) {
            throw new IllegalArgumentException("用户派生文本触发金融标识安全拒绝");
        }
    }

    private static boolean isStrictTechnicalValue(String key, String value) {
        String normalized = normalizedKey(key);
        if ((normalized.endsWith("hash")
                || "quoteobservationid".equals(normalized)
                || "quotededupkey".equals(normalized)
                || "contentfingerprint".equals(normalized))
                && STRICT_HASH.matcher(value).matches()) {
            return true;
        }
        switch (normalized) {
            case "sourceagent":
            case "sourcetype":
            case "sourcenode":
            case "sourcestage":
            case "platform":
            case "stationtype":
            case "portsemantics":
            case "clientversion":
            case "apppackage":
            case "capturemode":
            case "packagecategory":
            case "localparser":
            case "currency":
            case "unit":
            case "feature":
            case "quoteentry":
            case "fueltype":
            case "kind":
            case "status":
                return CONTROLLED_TECHNICAL.matcher(value).matches();
            default:
                return false;
        }
    }

    private static String scrubGeneratedTechnicalTokens(String key, String value) {
        String normalized = normalizedKey(key);
        switch (normalized) {
            case "localkey":
            case "stableidentity":
            case "originallocalkey":
            case "sessionid":
            case "editid":
            case "batchid":
            case "deviceid":
            case "devicesessionid":
            case "idempotencykey":
                return EMBEDDED_HEX_TOKEN.matcher(
                        UUID_TOKEN.matcher(value).replaceAll("")
                ).replaceAll("");
            default:
                return value;
        }
    }

    private static String normalizedKey(String key) {
        return key == null
                ? ""
                : key.replaceAll("[^A-Za-z0-9]", "").toLowerCase(Locale.ROOT);
    }
}
