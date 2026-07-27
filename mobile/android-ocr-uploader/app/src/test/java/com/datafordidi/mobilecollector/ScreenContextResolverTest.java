package com.datafordidi.mobilecollector;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ScreenContextResolverTest {
    @Test
    public void amapPackageWithoutBusinessEvidenceFailsClosedAndCityStillResolves() {
        assertFalse(
                "amap-charging".equals(
                ScreenContextResolver.platform(
                        "com.autonavi.minimap",
                        "",
                        new ArrayList<>(),
                        new ArrayList<>()
                )
                )
        );
        ScreenContextResolver.ParsedScreen uncertain = ScreenContextResolver.resolve(
                Arrays.asList(row("高德地图"), row("附近服务")),
                "com.autonavi.minimap",
                "screen-ocr-auto-scroll"
        );
        assertEquals("uncertain", uncertain.stationType);
        assertTrue(uncertain.isEmpty());
        assertEquals("西安", ScreenContextResolver.city(Arrays.asList(row("陕西省西安市雁塔区科技路"))));
    }

    @Test
    public void wechatNeedsPageEvidenceAndUnknownSlugIsStable() {
        String first = ScreenContextResolver.platform(
                "com.tencent.mm",
                "普通充电页面",
                new ArrayList<>(),
                new ArrayList<>()
        );
        String second = ScreenContextResolver.unknownPlatform("com.tencent.mm");
        assertEquals(second, first);
        assertFalse("didi-charging".equals(first));
        assertEquals("didi-charging", ScreenContextResolver.platform(
                "com.tencent.mm",
                "小桔充电",
                new ArrayList<>(),
                new ArrayList<>()
        ));
    }

    @Test
    public void missingCityUsesUnknownCity() {
        assertEquals(ScreenContextResolver.UNKNOWN_CITY, ScreenContextResolver.city(Arrays.asList(row("测试充电站"))));
    }

    @Test
    public void collectorScreenIsSkippedBeforeTargetLock() {
        assertTrue(ScreenContextResolver.isCollectorPage(Arrays.asList(
                row("信息自动识别"), row("开始 停止"), row("识别结果")
        )));
        assertFalse(ScreenContextResolver.isCollectorPage(Arrays.asList(
                row("西安测试充电站"), row("快充空闲 2/4")
        )));
        assertTrue(ScreenContextResolver.isCollectorPage(Arrays.asList(
                row("OCR 等待 · 回传失败"), row("识别结果"), row("刷新"), row("清空")
        )));
    }

    @Test
    public void mobileParserRoutingDoesNotRequireAddressCompleteness() {
        DidiLocalStationParser.StationRecord specialized = new DidiLocalStationParser.StationRecord();
        specialized.stationName = "小桔充电西安无地址充电站";
        specialized.priceFast = 0.88d;
        specialized.priceObserved = true;
        assertTrue(ParserSelectionPolicy.preferSpecialized(
                "didi-charging",
                "com.sdu.didi.psnger",
                "小桔充电",
                Arrays.asList(specialized),
                new ArrayList<>()
        ));
        assertFalse(specialized.address != null);
    }

    @Test
    public void userSelectedPlatformOverridesMissingPackageNameForFuel() {
        // 手动模式下拿不到包名（""），detector 会判 generic-fuel 被服务端拒；
        // 用户选了 tuanyou 后，resolveWithHint 应直接用 tuanyou 解析，platform 为 tuanyou。
        ScreenContextResolver.ParsedScreen parsed = ScreenContextResolver.resolveWithHint(
                Arrays.asList(
                        row("团油·筛选"),
                        row("浙江石油西湖塘河站"),
                        row("92# 油站价 7.06元/L")
                ),
                "tuanyou",
                "screen-ocr-manual-scroll"
        );
        assertEquals("fuel", parsed.stationType);
        assertEquals("tuanyou", parsed.platform);
        assertFalse(parsed.platform.startsWith("generic-fuel"));
    }

    @Test
    public void userSelectedChargingPlatformUsesChargingParser() {
        ScreenContextResolver.ParsedScreen parsed = ScreenContextResolver.resolveWithHint(
                Arrays.asList(row("杭州未来科技城充电站"), row("1.08元/度")),
                "didi-charging",
                "screen-ocr-manual-scroll"
        );
        assertEquals("charging", parsed.stationType);
        assertEquals("didi-charging", parsed.platform);
    }

    @Test
    public void emptyHintFallsBackToAutomaticResolve() {
        // 未选平台（auto）时退回原自动检测逻辑
        ScreenContextResolver.ParsedScreen parsed = ScreenContextResolver.resolveWithHint(
                Arrays.asList(row("非场站页面")),
                "",
                "screen-ocr-manual-scroll"
        );
        assertTrue(parsed.isEmpty());
    }

    @Test
    public void completeAmapFuelQuotePreviewMayContainOrderButtonButSecretsRemainBlocked() {
        assertFalse(ScreenContextResolver.isBlockedPage(Arrays.asList(
                row("浙江石油塘河供能加油站"),
                row("¥7.66/L 加200省¥5.09"),
                row("¥195.72"),
                row("本次油服务商团油提供"),
                row("确认支付")
        )));
        assertTrue(ScreenContextResolver.isBlockedPage(Arrays.asList(
                row("浙江石油塘河供能加油站"),
                row("¥7.66/L 加200省¥5.09"),
                row("¥195.72"),
                row("本次油服务商团油提供"),
                row("支付密码")
        )));
    }

    private static OcrRow row(String value) {
        return new OcrRow(value, 1f, 0.1f, 0.3f, 0.8f, 0.04f);
    }
}
