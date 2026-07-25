package com.datafordidi.mobilecollector;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * 开始识别前的平台选项定义：用户手动选择采集目标平台，避免手动模式下拿不到前台包名
 * 导致 detector 判成 generic-fuel 被服务端拒绝。
 *
 * 选项同时驱动 UI 展示标签与上报的 platform 值；isFuel 用于决定走燃油解析器还是充电解析器。
 */
public final class FuelPlatformHint {
    public static final String OPTION_AUTO = "auto";

    private FuelPlatformHint() {
    }

    public static final class Option {
        public final String value;
        public final String label;

        public Option(String value, String label) {
            this.value = value;
            this.label = label;
        }
    }

    public static List<Option> options() {
        return Collections.unmodifiableList(Arrays.asList(
                new Option(OPTION_AUTO, "自动识别(需无障碍)"),
                new Option("didi-charging", "滴滴充电"),
                new Option("amap-charging", "高德充电"),
                new Option("teld-charging", "特来电"),
                new Option("ykc-charging", "云快充"),
                new Option("xdt-charging", "新电途"),
                new Option("tuanyou", "团油"),
                new Option("amap-fuel", "高德加油")
        ));
    }

    /** 燃油平台：走 FuelStationParser，且上报时带 fuel-quote-v1 feature。 */
    public static boolean isFuel(String platform) {
        if (platform == null) return false;
        String value = platform.trim();
        return "tuanyou".equals(value) || "amap-fuel".equals(value);
    }

    /** 非自动识别（用户显式选了某个平台）。 */
    public static boolean isExplicit(String platform) {
        if (platform == null) return false;
        String value = platform.trim();
        return !value.isEmpty() && !OPTION_AUTO.equals(value);
    }
}
