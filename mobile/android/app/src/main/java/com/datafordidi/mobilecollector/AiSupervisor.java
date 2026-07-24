package com.datafordidi.mobilecollector;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

public class AiSupervisor {
    public enum PageType {
        LIST,
        DETAIL,
        SCANNER,
        LOGIN,
        MARKETING,
        EMPTY,
        UNKNOWN
    }

    public enum Action {
        NONE,
        BACK,
        SCROLL,
        WAIT,
        STOP
    }

    private static final int REPEATED_SCREEN_LIMIT = 3;
    private static final int UNKNOWN_STUCK_LIMIT = 3;
    private static final int EMPTY_STUCK_LIMIT = 3;

    private String lastHash = "";
    private String lastSignature = "";
    private int sameHashCount = 0;
    private int sameSignatureCount = 0;
    private int unknownCount = 0;
    private int emptyCount = 0;
    private int recoveryCount = 0;

    public Decision analyze(
            Context context,
            String sessionId,
            int pageIndex,
            String stage,
            String screenshotHash,
            List<OcrRow> rows,
            int localStationCount,
            boolean detailPending
    ) {
        PageType pageType = classify(rows);
        updateStuckCounters(pageType, screenshotHash, buildSignature(rows));

        Decision decision = new Decision();
        decision.sessionId = sessionId;
        decision.pageIndex = pageIndex;
        decision.stage = stage == null ? "phone-auto-scroll" : stage;
        decision.screenshotHash = screenshotHash;
        decision.pageType = pageType;
        decision.action = Action.NONE;
        decision.reason = "页面正常，继续执行既有采集流程";
        decision.sameHashCount = sameHashCount;
        decision.sameSignatureCount = sameSignatureCount;
        decision.recoveryCount = recoveryCount;
        decision.localStationCount = localStationCount;
        decision.rowCount = rows == null ? 0 : rows.size();
        decision.textSample = textSample(rows);

        if (!CollectorSettings.isAiSupervisorEnabled(context)) {
            decision.reason = "监督策略未开启";
            return decision;
        }

        if (pageType == PageType.SCANNER || pageType == PageType.LOGIN || pageType == PageType.MARKETING) {
            decision.action = Action.BACK;
            decision.reason = "识别到阻塞页面: " + pageType.name() + "，自动返回";
            recoveryCount += 1;
            decision.recoveryCount = recoveryCount;
            return decision;
        }

        if (pageType == PageType.EMPTY && emptyCount >= EMPTY_STUCK_LIMIT) {
            decision.action = Action.BACK;
            decision.reason = "连续空页面，自动返回恢复";
            recoveryCount += 1;
            decision.recoveryCount = recoveryCount;
            return decision;
        }

        if (detailPending && sameSignatureCount >= REPEATED_SCREEN_LIMIT) {
            decision.action = Action.BACK;
            decision.reason = "详情页连续无变化，自动返回列表";
            recoveryCount += 1;
            decision.recoveryCount = recoveryCount;
            return decision;
        }

        if (pageType == PageType.UNKNOWN && unknownCount >= UNKNOWN_STUCK_LIMIT) {
            decision.action = Action.BACK;
            decision.reason = "连续未知页面，自动返回恢复";
            recoveryCount += 1;
            decision.recoveryCount = recoveryCount;
            return decision;
        }

        if (pageType == PageType.LIST && sameSignatureCount >= REPEATED_SCREEN_LIMIT) {
            decision.action = Action.SCROLL;
            decision.reason = localStationCount == 0
                    ? "列表页连续无新增场站，强制补一次下滑"
                    : "列表页连续重复，强制补一次真实下滑";
            recoveryCount += 1;
            decision.recoveryCount = recoveryCount;
            return decision;
        }

        return decision;
    }

    private void updateStuckCounters(PageType pageType, String hash, String signature) {
        String safeHash = hash == null ? "" : hash;
        String safeSignature = signature == null ? "" : signature;
        if (!safeHash.isEmpty() && safeHash.equals(lastHash)) {
            sameHashCount += 1;
        } else {
            sameHashCount = 1;
            lastHash = safeHash;
        }

        if (!safeSignature.isEmpty() && safeSignature.equals(lastSignature)) {
            sameSignatureCount += 1;
        } else {
            sameSignatureCount = 1;
            lastSignature = safeSignature;
        }

        unknownCount = pageType == PageType.UNKNOWN ? unknownCount + 1 : 0;
        emptyCount = pageType == PageType.EMPTY ? emptyCount + 1 : 0;
    }

    public static PageType classify(List<OcrRow> rows) {
        if (rows == null || rows.isEmpty()) {
            return PageType.EMPTY;
        }

        String text = join(rows);
        if (contains(text, "相册") && (contains(text, "扫码") || contains(text, "扫一扫"))) {
            return PageType.SCANNER;
        }
        if (countMatches(text, new String[]{"手机号登录", "微信授权", "立即登录", "一键登录", "授权登录", "绑定手机", "同意并登录"}) >= 2) {
            return PageType.LOGIN;
        }
        if (DetailPageGuard.isDetailReady(rows)) {
            return PageType.DETAIL;
        }
        if (countMatches(text, new String[]{"场站环境", "场站坏境", "场站环坏境", "位置概览", "位置慨览", "指引路书", "根据提示进入车库", "进入车库", "即到达充电站", "小桔合作使用", "向左前方行驶", "向右前方行驶", "左转", "右转"}) >= 2) {
            return PageType.MARKETING;
        }
        if (countMatches(text, new String[]{"小红书", "条评论", "留下你的想法", "关注", "回复", "淘宝服务"}) >= 2) {
            return PageType.MARKETING;
        }
        if (countMatches(text, new String[]{"即将打开", "将打开", "取消", "允许", "打开小程序", "滴滴出行", "打车骑行公交", "租车代驾", "需要获取你的地理位置", "申请获取你的位置权限", "位置权限", "拒绝", "地理位置"}) >= 2) {
            return PageType.MARKETING;
        }
        if (countMatches(text, new String[]{"领取优惠", "新人专享", "立即参与", "活动规则", "优惠券", "限时活动", "立即领取", "开通会员"}) >= 3) {
            return PageType.MARKETING;
        }
        if (DetailPageGuard.looksLikeListPage(rows) || looksLikeStationList(rows, text)) {
            return PageType.LIST;
        }
        return PageType.UNKNOWN;
    }

    private static boolean looksLikeStationList(List<OcrRow> rows, String text) {
        // 高德充电站列表特征：
        // 1) 多行"充电站"关键词 + 距离(m/km)
        // 2) "空闲X/Y" 或 "快充" + "慢充" 字样
        boolean hasAmapCharging = countMatches(text, new String[]{"充电站", "充电桩", "空闲", "快充", "慢充", "超充"}) >= 2;
        boolean hasDistance = text.matches(".*\\d+(\\.\\d+)?\\s*(m|km|米|公里).*");

        int stationLike = 0;
        for (OcrRow row : rows) {
            String value = compact(row.text);
            if (value.isEmpty()) continue;
            // 高德站名：通常含"充电站"或中文字符较多的短文本
            boolean looksLikeAmapStation = value.contains("充电站")
                    || value.contains("充电桩");
            boolean looksLikeName = value.length() >= 4
                    && value.length() <= 50
                    && value.matches(".*[\\u4e00-\\u9fa5].*")
                    && !value.matches("^[¥￥]?\\d.*")
                    && !value.contains("首页")
                    && !value.contains("我的")
                    && !value.contains("扫码")
                    && !value.contains("服务费")
                    && !value.contains("超时")
                    && !value.contains("导航")
                    && !value.contains("路线")
                    && !value.contains("图层");
            if (looksLikeAmapStation || looksLikeName) {
                stationLike += 1;
            }
        }

        // 滴滴页面检测
        boolean hasDidiPrice = text.matches(".*[¥￥]\\s*\\d+(\\.\\d+)?\\s*/?\\s*度.*");
        boolean hasDidiPorts = text.matches(".*(超|快|慢)?(闲|空闲)\\s*\\d+\\s*/\\s*\\d+.*");
        boolean isDidiList = stationLike >= 2 && (hasDidiPrice || hasDidiPorts);

        // 高德页面检测：有多个充电站关键词或有距离信息
        boolean isAmapList = hasAmapCharging && (stationLike >= 2 || hasDistance);

        return isDidiList || isAmapList;
    }

    private static String buildSignature(List<OcrRow> rows) {
        StringBuilder builder = new StringBuilder();
        if (rows != null) {
            for (OcrRow row : rows) {
                String value = compact(row.text);
                if (value.isEmpty() || isVolatileSignatureText(row, value)) {
                    continue;
                }
                builder.append(value).append(' ');
            }
        }
        String text = builder.toString().trim();
        if (text.length() > 180) {
            return text.substring(0, 180);
        }
        return text;
    }

    private static boolean isVolatileSignatureText(OcrRow row, String text) {
        if (row != null && (row.y < 0.10f || row.y > 0.92f)) {
            return true;
        }
        return text.contains("OCR采集中")
                || text.contains("0CR采集中")
                || text.contains("暂停")
                || text.contains("重启")
                || text.contains("停止")
                || text.contains("常用")
                || text.contains("附近")
                || text.contains("地图")
                || text.contains("筛选")
                || text.contains("首页")
                || text.contains("我的")
                || text.matches(".*(晚上|上午|下午)?\\d{1,2}:\\d{2}.*")
                || text.matches(".*\\d+(\\.\\d+)?K/s.*")
                || text.contains("5G")
                || text.contains("HD");
    }

    private static String textSample(List<OcrRow> rows) {
        String text = join(rows);
        if (text.length() > 260) {
            return text.substring(0, 260);
        }
        return text;
    }

    private static String join(List<OcrRow> rows) {
        StringBuilder builder = new StringBuilder();
        if (rows == null) {
            return "";
        }
        for (OcrRow row : rows) {
            String value = compact(row.text);
            if (!value.isEmpty()) {
                builder.append(value).append(' ');
            }
        }
        return builder.toString().trim();
    }

    private static int countMatches(String text, String[] keywords) {
        int count = 0;
        for (String keyword : keywords) {
            if (contains(text, keyword)) {
                count += 1;
            }
        }
        return count;
    }

    private static boolean contains(String text, String keyword) {
        return text != null && text.contains(keyword);
    }

    private static String compact(String text) {
        return String.valueOf(text == null ? "" : text).replaceAll("\\s+", "").trim();
    }

    public static final class Decision {
        public String sessionId;
        public int pageIndex;
        public String stage;
        public String screenshotHash;
        public PageType pageType;
        public Action action;
        public String reason;
        public int sameHashCount;
        public int sameSignatureCount;
        public int recoveryCount;
        public int localStationCount;
        public int rowCount;
        public String textSample;

        public boolean shouldRecover() {
            return action == Action.BACK || action == Action.SCROLL || action == Action.STOP;
        }

        public JSONObject toJson() throws Exception {
            return new JSONObject()
                    .put("sessionId", sessionId)
                    .put("pageIndex", pageIndex)
                    .put("stage", stage)
                    .put("screenshotHash", screenshotHash == null ? JSONObject.NULL : screenshotHash)
                    .put("pageType", pageType == null ? "UNKNOWN" : pageType.name())
                    .put("action", action == null ? "NONE" : action.name())
                    .put("reason", reason)
                    .put("sameHashCount", sameHashCount)
                    .put("sameSignatureCount", sameSignatureCount)
                    .put("recoveryCount", recoveryCount)
                    .put("localStationCount", localStationCount)
                    .put("rowCount", rowCount)
                    .put("textSample", textSample == null ? "" : textSample);
        }

        public static Decision fromJson(JSONObject json, Decision fallback) {
            if (json == null) {
                return fallback;
            }
            Decision decision = new Decision();
            decision.sessionId = json.optString("sessionId", fallback == null ? "" : fallback.sessionId);
            decision.pageIndex = json.optInt("pageIndex", fallback == null ? 0 : fallback.pageIndex);
            decision.stage = json.optString("stage", fallback == null ? "phone-auto-scroll" : fallback.stage);
            decision.screenshotHash = json.optString("screenshotHash", fallback == null ? "" : fallback.screenshotHash);
            decision.pageType = parsePageType(json.optString("pageType", fallback == null || fallback.pageType == null ? "UNKNOWN" : fallback.pageType.name()));
            decision.action = parseAction(json.optString("action", fallback == null || fallback.action == null ? "NONE" : fallback.action.name()));
            decision.reason = json.optString("reason", fallback == null ? "" : fallback.reason);
            decision.sameHashCount = json.optInt("sameHashCount", fallback == null ? 0 : fallback.sameHashCount);
            decision.sameSignatureCount = json.optInt("sameSignatureCount", fallback == null ? 0 : fallback.sameSignatureCount);
            decision.recoveryCount = json.optInt("recoveryCount", fallback == null ? 0 : fallback.recoveryCount);
            decision.localStationCount = json.optInt("localStationCount", fallback == null ? 0 : fallback.localStationCount);
            decision.rowCount = json.optInt("rowCount", fallback == null ? 0 : fallback.rowCount);
            decision.textSample = json.optString("textSample", fallback == null ? "" : fallback.textSample);
            return decision;
        }

        private static PageType parsePageType(String value) {
            try {
                return PageType.valueOf(String.valueOf(value == null ? "UNKNOWN" : value).trim());
            } catch (Exception ignored) {
                return PageType.UNKNOWN;
            }
        }

        private static Action parseAction(String value) {
            try {
                return Action.valueOf(String.valueOf(value == null ? "NONE" : value).trim());
            } catch (Exception ignored) {
                return Action.NONE;
            }
        }
    }
}
