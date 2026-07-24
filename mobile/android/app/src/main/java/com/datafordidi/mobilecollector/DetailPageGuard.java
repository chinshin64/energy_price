package com.datafordidi.mobilecollector;

import java.util.List;

public final class DetailPageGuard {
    public static final int MAX_DETAIL_CAPTURE_ATTEMPTS = 7;

    private static final String[] STRONG_DETAIL_SIGNALS = {
            "场站详情", "站点详情", "站点地址", "详细地址", "营业时间", "费用详情",
            "收费标准", "超时占用费", "停车减免", "充电须知", "充电费用",
            "当前时段", "枪编号", "枪桩信息", "可用充电", "距离您"
    };

    private DetailPageGuard() {
    }

    public static boolean isDetailReady(List<OcrRow> rows) {
        if (rows == null || rows.isEmpty() || PageGuard.shouldBackOut(rows)) {
            return false;
        }

        String text = join(rows);
        int stationTitleCount = countStationTitles(rows);
        boolean strongDetail = containsAny(text, STRONG_DETAIL_SIGNALS);
        boolean hasDetailData = hasAddress(rows) || hasEnergyPrice(text) || hasPortSummary(text);
        if (strongDetail && hasDetailData) {
            return true;
        }
        if (stationTitleCount != 1) {
            return false;
        }
        if (looksLikeListPage(rows) && !containsAny(text, STRONG_DETAIL_SIGNALS)) {
            return false;
        }

        return hasCompleteStationTitle(rows)
                && hasAddress(rows)
                && (hasEnergyPrice(text) || hasPortSummary(text));
    }

    public static boolean looksLikeListPage(List<OcrRow> rows) {
        if (rows == null || rows.isEmpty()) {
            return false;
        }
        String text = join(rows);
        boolean listChrome = text.contains("附近充电站")
                || text.contains("筛选")
                || text.contains("距离最近")
                || text.contains("推荐排序");
        boolean repeatedCards = countStationTitles(rows) >= 2
                && (text.contains("km") || text.contains("公里"))
                && !containsAny(text, STRONG_DETAIL_SIGNALS);
        boolean singleCard = countStationTitles(rows) >= 1
                && (text.contains("km") || text.contains("公里") || text.matches(".*\\d{2,4}m.*"))
                && (hasEnergyPrice(text) || hasPortSummary(text))
                && !hasAddress(rows)
                && !containsAny(text, STRONG_DETAIL_SIGNALS);
        return listChrome || repeatedCards || singleCard;
    }

    private static int countStationTitles(List<OcrRow> rows) {
        int count = 0;
        for (OcrRow row : rows) {
            if (isStationTitleCandidate(row.text)) {
                count += 1;
            }
        }
        return count;
    }

    private static boolean hasCompleteStationTitle(List<OcrRow> rows) {
        for (OcrRow row : rows) {
            String text = compact(row.text);
            if (isStationTitleCandidate(text) && !isTruncated(text)) {
                return true;
            }
        }
        return false;
    }

    private static boolean hasAddress(List<OcrRow> rows) {
        for (OcrRow row : rows) {
            String text = compact(row.text);
            if (text.length() < 6 || text.length() > 90) {
                continue;
            }
            if (text.matches(".*(省|市|区|县|镇|路|街|道|号|栋|楼|大厦|广场|园区|停车场|地下).*")) {
                if (!hasEnergyPrice(text) && !hasPortSummary(text) && !text.contains("超时占用费")) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean hasEnergyPrice(String text) {
        return text.matches(".*[¥￥]?\\d+(\\.\\d+)?\\s*(元)?\\s*/\\s*(度|千瓦时|kWh|KWH).*")
                || text.matches(".*(电价|服务费|充电费).*\\d+(\\.\\d+)?.*");
    }

    private static boolean hasPortSummary(String text) {
        return text.matches(".*(快|慢|超)?(闲|空闲)\\s*\\d+\\s*/\\s*\\d+.*")
                || text.matches(".*(快充|慢充|超充).*\\d+.*(枪|个|支).*");
    }

    private static boolean isStationTitleCandidate(String text) {
        String compact = compact(text).replaceAll("^[^\\u4e00-\\u9fa5]+", "");
        if (compact.length() < 4) {
            return false;
        }
        boolean hasChargingWord = compact.contains("充电") || compact.contains("超充") || compact.contains("快充");
        boolean looksLikeStationName = compact.length() >= 5
                && compact.length() <= 42
                && compact.matches(".*[\\u4e00-\\u9fa5].*");
        if (!hasChargingWord && !looksLikeStationName) {
            return false;
        }
        return !compact.matches("^[¥￥]?\\d.*")
                && !compact.contains("登录")
                && !compact.contains("首页")
                && !compact.contains("我的")
                && !compact.contains("超时")
                && !compact.contains("停车")
                && !compact.contains("优惠")
                && !compact.contains("余额")
                && !compact.contains("订单")
                && !compact.contains("会员")
                && !compact.contains("须知")
                && !compact.contains("费用")
                && !compact.contains("福利")
                && !compact.contains("活动")
                && !compact.contains("奖励")
                && !compact.contains("补充车辆")
                && !compact.contains("免费充电")
                && !compact.contains("开始充电")
                && !compact.contains("搜索附近")
                && !compact.contains("搜索")
                && !compact.contains("附近")
                && !compact.contains("地图")
                && !compact.contains("筛选")
                && !compact.contains("广告")
                && !compact.contains("跳过")
                && !compact.contains("近期最大")
                && !compact.contains("分钟前有人充过")
                && !compact.contains("服务费")
                && !compact.contains("场站优惠")
                && !compact.matches("^\\d.*");
    }

    private static boolean isTruncated(String text) {
        String value = compact(text);
        return value.contains("..") || value.contains("…");
    }

    private static String join(List<OcrRow> rows) {
        StringBuilder builder = new StringBuilder();
        for (OcrRow row : rows) {
            builder.append(compact(row.text));
        }
        return builder.toString();
    }

    private static boolean containsAny(String text, String[] keywords) {
        for (String keyword : keywords) {
            if (text.contains(keyword)) {
                return true;
            }
        }
        return false;
    }

    private static String compact(String text) {
        return String.valueOf(text == null ? "" : text).replaceAll("\\s+", "");
    }
}
