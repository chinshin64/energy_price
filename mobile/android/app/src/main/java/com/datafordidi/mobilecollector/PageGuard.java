package com.datafordidi.mobilecollector;

import java.util.List;

public final class PageGuard {
    private static final String[] STATION_SIGNALS = {
            "充电站", "充电", "快充", "慢充", "超充", "空闲", "总数", "枪",
            "元/度", "元/kWh", "¥", "￥", "电价", "导航", "距离", "km", "公里"
    };
    private static final String[] LOGIN_SIGNALS = {
            "手机号登录", "微信授权", "立即登录", "一键登录", "授权登录", "登录后",
            "绑定手机", "同意并登录", "隐私政策", "用户协议"
    };
    private static final String[] MARKETING_SIGNALS = {
            "领取优惠", "新人专享", "立即参与", "活动规则", "优惠券", "限时活动",
            "去使用", "立即领取", "开通会员", "邀好友"
    };
    private static final String[] BLOCKING_MODAL_SIGNALS = {
            "即将打开", "将打开", "取消", "允许", "打开小程序", "滴滴出行",
            "打车骑行公交", "租车代驾", "需要获取你的地理位置", "申请获取你的位置权限",
            "位置权限", "拒绝", "地理位置"
    };
    private static final String[] DETAIL_SUBPAGE_SIGNALS = {
            "场站环境", "场站坏境", "场站环坏境", "位置概览", "位置慨览", "指引路书",
            "根据提示进入车库", "进入车库", "即到达充电站", "小桔合作使用",
            "向左前方行驶", "向右前方行驶", "左转", "右转"
    };
    private static final String[] EXTERNAL_APP_SIGNALS = {
            "小红书", "共", "条评论", "留下你的想法", "关注", "回复", "淘宝服务"
    };

    private PageGuard() {
    }

    public static boolean shouldBackOut(List<OcrRow> rows) {
        if (rows == null || rows.isEmpty()) {
            return false;
        }
        StringBuilder joined = new StringBuilder();
        for (OcrRow row : rows) {
            joined.append(row.text);
        }
        String text = joined.toString();
        if (looksLikeUsefulStationDetail(text)) {
            return false;
        }
        if (text.contains("相册") && (text.contains("扫码") || text.contains("扫一扫"))) {
            return true;
        }
        if (countMatches(text, DETAIL_SUBPAGE_SIGNALS) >= 2) {
            return true;
        }
        if (countMatches(text, EXTERNAL_APP_SIGNALS) >= 2) {
            return true;
        }
        if (countMatches(text, BLOCKING_MODAL_SIGNALS) >= 2) {
            return true;
        }
        if (containsAny(text, STATION_SIGNALS)) {
            return false;
        }

        int loginScore = countMatches(text, LOGIN_SIGNALS);
        if (loginScore >= 2) {
            return true;
        }

        int marketingScore = countMatches(text, MARKETING_SIGNALS);
        return marketingScore >= 3 && text.length() < 500;
    }

    private static boolean looksLikeUsefulStationDetail(String text) {
        boolean detailShell = text.contains("场站详情")
                || text.contains("站点详情")
                || text.contains("充电费用")
                || text.contains("当前时段")
                || text.contains("枪编号")
                || text.contains("枪桩信息");
        boolean hasStationData = text.matches(".*[¥￥]?\\d+(\\.\\d+)?\\s*(元)?\\s*/?\\s*(度|千瓦时|kWh|KWH).*")
                || text.matches(".*(快|慢|超)?(闲|空闲)\\s*\\d+\\s*/\\s*\\d+.*")
                || text.matches(".*(省|市|区|县|镇|路|街|道|号|栋|楼|大厦|广场|园区|停车场|地下).*");
        return detailShell && hasStationData;
    }

    private static boolean containsAny(String text, String[] keywords) {
        return countMatches(text, keywords) > 0;
    }

    private static int countMatches(String text, String[] keywords) {
        int count = 0;
        for (String keyword : keywords) {
            if (text.contains(keyword)) {
                count += 1;
            }
        }
        return count;
    }
}
