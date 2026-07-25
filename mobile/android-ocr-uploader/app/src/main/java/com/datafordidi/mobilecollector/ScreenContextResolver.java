package com.datafordidi.mobilecollector;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class ScreenContextResolver {
    static final String UNKNOWN_CITY = "未知城市";
    private static final List<String> CITIES = Arrays.asList(
            "北京", "上海", "天津", "重庆", "西安", "武汉", "广州", "深圳", "杭州", "南京",
            "成都", "苏州", "郑州", "长沙", "青岛", "宁波", "合肥", "厦门", "福州", "济南",
            "大连", "沈阳", "哈尔滨", "长春", "石家庄", "太原", "南昌", "南宁", "昆明", "贵阳",
            "海口", "兰州", "银川", "西宁", "乌鲁木齐", "呼和浩特", "无锡", "常州", "佛山",
            "东莞", "珠海", "中山", "温州", "嘉兴", "绍兴", "金华", "泉州", "徐州", "南通"
    );
    private static final Pattern PROVINCE_CITY = Pattern.compile("(?:省|自治区)([\\u4e00-\\u9fa5]{2,8})市");
    private static final Pattern LEADING_CITY = Pattern.compile("^([\\u4e00-\\u9fa5]{2,8})市(?:[\\u4e00-\\u9fa5]{1,4}(?:区|县)|[路街道号])");

    private ScreenContextResolver() {
    }

    static ParsedScreen resolve(List<OcrRow> rows, String packageName, String sourceStage) {
        String pageText = join(rows);
        if (FuelPlatformDetector.isConflict(rows)) {
            return ParsedScreen.conflict(city(rows));
        }
        String fuelPlatform = FuelPlatformDetector.detect(rows, packageName);
        if (!fuelPlatform.isEmpty()) {
            List<FuelStationRecord> fuelStations = FuelStationParser.extract(rows, fuelPlatform, sourceStage);
            return ParsedScreen.fuel(fuelPlatform, city(rows), fuelStations);
        }
        if (isAmapContext(packageName, pageText)
                && FuelPlatformDetector.chargingEvidence(pageText) < 2) {
            return ParsedScreen.uncertain(city(rows));
        }
        List<DidiLocalStationParser.StationRecord> didi = DidiLocalStationParser.extract(rows, sourceStage);
        List<DidiLocalStationParser.StationRecord> amap = AmapStationParser.extract(rows, sourceStage);
        String platform = platform(packageName, pageText, didi, amap);

        List<DidiLocalStationParser.StationRecord> generic = GenericStationParser.extract(rows, platform, sourceStage);

        List<DidiLocalStationParser.StationRecord> candidateSpecialized = "amap-charging".equals(platform) ? amap
                : "didi-charging".equals(platform) ? didi
                : new ArrayList<>();
        List<DidiLocalStationParser.StationRecord> specialized = ParserSelectionPolicy.preferSpecialized(
                platform,
                packageName,
                pageText,
                candidateSpecialized,
                generic
        ) ? candidateSpecialized : new ArrayList<>();
        Map<String, DidiLocalStationParser.StationRecord> merged = new LinkedHashMap<>();
        for (DidiLocalStationParser.StationRecord station : specialized) {
            station.platform = platform;
            merged.put(key(station.stationName), station);
        }
        for (DidiLocalStationParser.StationRecord station : generic) {
            String key = key(station.stationName);
            if (!merged.containsKey(key)) merged.put(key, station);
        }
        List<DidiLocalStationParser.StationRecord> stations = new ArrayList<>(merged.values());
        for (DidiLocalStationParser.StationRecord station : stations) station.screenRowCount = rows == null ? 0 : rows.size();
        return ParsedScreen.charging(platform, city(rows), stations);
    }

    /**
     * 用户在开始识别前手动选择了平台时使用：跳过包名/品牌词自动检测，直接用所选平台解析。
     * 解决手动下滑模式下拿不到前台包名、detector 判成 generic-fuel 被 47 拒绝的问题。
     */
    static ParsedScreen resolveWithHint(List<OcrRow> rows, String userPlatform, String sourceStage) {
        if (userPlatform == null || userPlatform.trim().isEmpty()) {
            return resolve(rows, "", sourceStage);
        }
        String platform = compact(userPlatform);
        if (FuelPlatformHint.isFuel(platform)) {
            List<FuelStationRecord> fuelStations = FuelStationParser.extract(rows, platform, sourceStage);
            return ParsedScreen.fuel(platform, city(rows), fuelStations);
        }
        List<DidiLocalStationParser.StationRecord> generic = GenericStationParser.extract(rows, platform, sourceStage);
        for (DidiLocalStationParser.StationRecord station : generic) {
            station.platform = platform;
            station.screenRowCount = rows == null ? 0 : rows.size();
        }
        return ParsedScreen.charging(platform, city(rows), generic);
    }

    static String platform(
            String packageName,
            String pageText,
            List<DidiLocalStationParser.StationRecord> didi,
            List<DidiLocalStationParser.StationRecord> amap
    ) {
        String packageValue = compact(packageName).toLowerCase(Locale.ROOT);
        String text = compact(pageText);
        if ((packageValue.equals("com.autonavi.minimap")
                || text.contains("高德地图")
                || text.contains("高德红包"))
                && FuelPlatformDetector.chargingEvidence(text) >= 2) {
            return "amap-charging";
        }
        if (packageValue.equals("com.sdu.didi.psnger") || packageValue.equals("com.didapinche.booking")
                || text.contains("滴滴充电") || text.contains("小桔充电")) {
            return "didi-charging";
        }
        return unknownPlatform(packageValue);
    }

    private static boolean isAmapContext(String packageName, String pageText) {
        String packageValue = compact(packageName).toLowerCase(Locale.ROOT);
        String text = compact(pageText);
        return packageValue.equals("com.autonavi.minimap")
                || text.contains("高德地图")
                || text.contains("高德红包")
                || text.contains("高德加油");
    }

    static String city(List<OcrRow> rows) {
        for (OcrRow row : rows) {
            String text = compact(row.text);
            for (String city : CITIES) {
                if (text.contains(city + "市") || text.contains(city)) return city;
            }
        }
        for (OcrRow row : rows) {
            String text = compact(row.text);
            Matcher province = PROVINCE_CITY.matcher(text);
            if (province.find()) return province.group(1);
            Matcher leading = LEADING_CITY.matcher(text);
            if (leading.find()) return leading.group(1);
        }
        return UNKNOWN_CITY;
    }

    static String unknownPlatform(String packageName) {
        String value = compact(packageName).toLowerCase(Locale.ROOT);
        if (value.isEmpty()) value = "unknown";
        return "generic-charging-" + DeviceIdentity.sha256(value).substring(0, 12);
    }

    static boolean isBlockedPage(List<OcrRow> rows) {
        String text = compact(join(rows));
        return text.contains("输入密码")
                || text.contains("短信验证码")
                || text.contains("支付密码")
                || text.contains("收银台")
                || text.contains("确认支付")
                || text.contains("确认付款")
                || text.contains("提交订单")
                || text.contains("创建订单")
                || text.contains("确认下单")
                || text.contains("银行卡支付")
                || text.contains("授权登录")
                || text.contains("人脸识别")
                || text.contains("银行卡号")
                || text.contains("身份验证")
                || text.contains("登录后使用");
    }

    static boolean isCollectorPage(List<OcrRow> rows) {
        String text = compact(join(rows));
        if (!text.contains("识别结果")) return false;
        if (text.contains("信息自动识别") && (text.contains("开始") || text.contains("停止"))) return true;
        int signals = 0;
        if (text.contains("OCR")) signals++;
        if (text.contains("刷新")) signals++;
        if (text.contains("清空")) signals++;
        if (text.contains("回传") || text.contains("仅本地") || text.contains("待重试")) signals++;
        if (text.matches(".*20\\d{2}-\\d{2}-\\d{2}T\\d{2}:\\d{2}.*")) signals++;
        if (text.contains("枪：闲") || text.contains("枪:闲")) signals++;
        return signals >= 2;
    }

    private static String join(List<OcrRow> rows) {
        StringBuilder output = new StringBuilder();
        if (rows != null) for (OcrRow row : rows) output.append(row.text).append(' ');
        return output.toString();
    }

    private static String key(String name) {
        return compact(name);
    }

    private static String compact(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }

    static final class ParsedScreen {
        final String platform;
        final String city;
        final String stationType;
        final List<DidiLocalStationParser.StationRecord> stations;
        final List<FuelStationRecord> fuelStations;

        private ParsedScreen(
                String platform,
                String city,
                String stationType,
                List<DidiLocalStationParser.StationRecord> stations,
                List<FuelStationRecord> fuelStations
        ) {
            this.platform = platform;
            this.city = city;
            this.stationType = stationType;
            this.stations = stations;
            this.fuelStations = fuelStations;
        }

        static ParsedScreen charging(
                String platform,
                String city,
                List<DidiLocalStationParser.StationRecord> stations
        ) {
            return new ParsedScreen(platform, city, "charging", stations, new ArrayList<>());
        }

        static ParsedScreen fuel(String platform, String city, List<FuelStationRecord> stations) {
            return new ParsedScreen(platform, city, "fuel", new ArrayList<>(), stations);
        }

        static ParsedScreen conflict(String city) {
            return new ParsedScreen("", city, "conflict", new ArrayList<>(), new ArrayList<>());
        }

        static ParsedScreen uncertain(String city) {
            return new ParsedScreen("", city, "uncertain", new ArrayList<>(), new ArrayList<>());
        }

        int size() {
            return "fuel".equals(stationType) ? fuelStations.size() : stations.size();
        }

        boolean isEmpty() {
            return size() == 0;
        }
    }
}
