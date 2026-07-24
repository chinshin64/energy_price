package com.datafordidi.mobilecollector;

import org.json.JSONObject;
import org.junit.Test;

import java.math.BigDecimal;
import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public class AmapFuelQuoteParserTest {
    private static final String CAPTURED_AT = "2026-07-23T12:00:00Z";
    private static final String MOCK_PHONE = "138" + "1234" + "5678";

    @Test
    public void amapFuelUsesDedicatedPlatformAndParsesProviderThreePricesAndQuote() {
        List<OcrRow> rows = Arrays.asList(
                row("高德加油", .05f, .08f),
                row("中石油高新加油站", .05f, .17f),
                row("92#汽油", .05f, .23f),
                row("外显价 6.6300元/升", .05f, .28f),
                row("油站价 7.8600元/升", .05f, .33f),
                row("国标价 8.1200元/升", .05f, .38f),
                row("服务商：测试能源科技", .05f, .52f),
                row("加油金额 200.00元", .05f, .60f),
                row("优惠金额 20.65元", .05f, .65f),
                row("服务费 3.30元", .05f, .70f),
                row("预计实付 182.65元", .05f, .75f)
        );

        assertEquals("amap-fuel", FuelPlatformDetector.detect(rows, "com.autonavi.minimap"));
        ScreenContextResolver.ParsedScreen parsed = ScreenContextResolver.resolve(
                rows,
                "com.autonavi.minimap",
                "screen-ocr-user-driven"
        );
        assertEquals("fuel", parsed.stationType);
        assertEquals("amap-fuel", parsed.platform);
        assertEquals(1, parsed.fuelStations.size());

        FuelStationRecord station = parsed.fuelStations.get(0);
        assertEquals("测试能源科技", station.providerName);
        assertNotNull(station.providerEvidence);
        assertEquals("provider-attribution", station.providerEvidence.optString("kind"));
        assertEquals("测试能源科技", station.providerEvidence.optString("text"));
        assertFalse(station.providerEvidence.toString().contains("服务商"));
        assertEquals(1, station.fuelOffers.size());
        FuelOffer offer = station.fuelOffers.get(0);
        assertEquals(0, new BigDecimal("6.6300").compareTo(offer.displayPrice));
        assertEquals(0, new BigDecimal("7.8600").compareTo(offer.stationPrice));
        assertEquals(0, new BigDecimal("8.1200").compareTo(offer.nationalPrice));
        assertEquals(7.86d, offer.listPrice, 0.00001d);
        assertEquals(6.63d, offer.discountPrice, 0.00001d);
        assertEquals(1, station.fuelQuotes.size());

        station.capturedAt = CAPTURED_AT;
        offer.capturedAt = CAPTURED_AT;
        FuelQuote quote = station.fuelQuotes.get(0);
        quote.capturedAt = CAPTURED_AT;
        quote.finalizeIdentity(station.platform, station.sourceStationKey(), offer, station.providerName);
        JSONObject envelope = station.observationJson("西安");
        assertFalse(envelope.has("feature"));
        JSONObject common = envelope.optJSONObject("stationObservation");
        assertTrue(common.isNull("address"));
        assertTrue(common.isNull("availablePorts"));
    }

    @Test
    public void amapChargingAndMixedSemanticsNeverBecomeAmapFuel() {
        List<OcrRow> charging = Arrays.asList(
                row("高德地图", .05f, .08f),
                row("高新超级充电站", .05f, .17f),
                row("快充 空闲枪 6 总枪 12", .05f, .24f),
                row("0.88元/度", .05f, .30f)
        );
        assertEquals("", FuelPlatformDetector.detect(charging, "com.autonavi.minimap"));
        assertEquals("amap-charging", ScreenContextResolver.resolve(
                charging,
                "com.autonavi.minimap",
                "screen-ocr-auto-scroll"
        ).platform);

        List<OcrRow> mixed = Arrays.asList(
                row("高德地图 92#汽油 外显价6.63元/升 油站价7.86元/升", .05f, .1f),
                row("超级充电站 快充 空闲枪6 0.88元/度", .05f, .2f)
        );
        assertTrue(FuelPlatformDetector.isConflict(mixed));
        ScreenContextResolver.ParsedScreen conflict = ScreenContextResolver.resolve(
                mixed,
                "com.autonavi.minimap",
                "screen-ocr-user-driven"
        );
        assertEquals("conflict", conflict.stationType);
        assertTrue(conflict.isEmpty());
    }

    @Test
    public void amapLowFuelAndChargingEvidenceFailsClosedBeforeAutoScroll() {
        for (List<OcrRow> rows : Arrays.asList(
                Arrays.asList(
                        row("高德地图", .05f, .08f),
                        row("92#", .05f, .17f),
                        row("附近优惠", .05f, .24f)
                ),
                Arrays.asList(
                        row("高德地图", .05f, .08f),
                        row("附近充电", .05f, .17f),
                        row("路线", .05f, .24f)
                )
        )) {
            ScreenContextResolver.ParsedScreen parsed = ScreenContextResolver.resolve(
                    rows,
                    "com.autonavi.minimap",
                    "screen-ocr-auto-scroll"
            );
            assertEquals("uncertain", parsed.stationType);
            assertFalse("amap-charging".equals(parsed.platform));
            assertTrue(parsed.isEmpty());
            assertFalse(CaptureInteractionPolicy.isAllowed(
                    parsed.stationType,
                    CaptureInteractionPolicy.Action.SCROLL_FORWARD
            ));
        }
    }

    @Test
    public void quotePreviewWithPaymentButtonIsReadOnlyOcrButSensitivePaymentPagesStayBlocked() {
        List<OcrRow> quotePreview = Arrays.asList(
                row("高德加油", .05f, .05f),
                row("中石油高新加油站", .05f, .12f),
                row("92#汽油", .05f, .18f),
                row("外显价 6.6300元/升", .05f, .24f),
                row("油站价 7.8600元/升", .05f, .30f),
                row("国标价 8.1200元/升", .05f, .36f),
                row("加油金额 200.00元", .05f, .48f),
                row("优惠金额 20.65元", .05f, .54f),
                row("服务费 3.30元", .05f, .60f),
                row("预计实付 182.65元", .05f, .66f),
                row("立即支付", .60f, .88f),
                row("去支付", .76f, .88f)
        );
        assertFalse(ScreenContextResolver.isBlockedPage(quotePreview));
        ScreenContextResolver.ParsedScreen preview = ScreenContextResolver.resolve(
                quotePreview,
                "com.autonavi.minimap",
                "screen-ocr-user-driven"
        );
        assertEquals("fuel", preview.stationType);
        assertEquals(1, preview.fuelStations.size());
        int allowedActions = 0;
        for (CaptureInteractionPolicy.Action action : CaptureInteractionPolicy.Action.values()) {
            if (CaptureInteractionPolicy.isAllowed(preview.stationType, action)) allowedActions++;
        }
        assertEquals(0, allowedActions);

        for (String text : Arrays.asList(
                "收银台 确认支付 ¥182.65",
                "确认付款",
                "提交订单",
                "支付密码",
                "短信验证码",
                "银行卡支付",
                "银行卡号 6222 请输入卡片信息",
                "身份验证 人脸识别",
                "请输入验证码完成确认支付"
        )) {
            List<OcrRow> sensitive = Arrays.asList(
                    row("高德加油", .05f, .05f),
                    row("中石油高新加油站", .05f, .12f),
                    row("92#汽油 外显价 6.63元/升", .05f, .18f),
                    row("预计实付 182.65元", .05f, .24f),
                    row(text, .1f, .70f)
            );
            assertTrue(text, ScreenContextResolver.isBlockedPage(sensitive));
        }
    }

    @Test
    public void providerAndPopupClassificationRequireExactEvidence() {
        List<OcrRow> inline = Arrays.asList(
                row("高德加油", .05f, .05f),
                row("中石油高新加油站", .05f, .12f),
                row("92#汽油 外显价 6.6300元/升", .05f, .20f),
                row("本次由服务商团油提供", .05f, .28f),
                row("加油金额 200.00元", .05f, .40f),
                row("优惠金额 20.65元", .05f, .47f),
                row("服务费 3.30元", .05f, .54f),
                row("预计实付 182.65元", .05f, .61f),
                row("查看优惠说明", .05f, .70f)
        );
        FuelStationRecord inlineStation = FuelStationParser.extract(
                inline, "amap-fuel", "screen-ocr-user-driven"
        ).get(0);
        assertEquals("团油", inlineStation.providerName);
        assertEquals("inline", inlineStation.fuelQuotes.get(0).quoteEntry);

        List<OcrRow> popup = Arrays.asList(
                row("中石油高新加油站", .05f, .12f),
                row("92#汽油 外显价 6.6300元/升", .05f, .20f),
                row("优惠说明", .05f, .28f),
                row("优惠金额 20.65元", .05f, .40f),
                row("服务费 3.30元", .05f, .47f),
                row("加油金额 200.00元", .05f, .54f),
                row("预计实付 182.65元", .05f, .61f),
                row("关闭", .80f, .08f)
        );
        assertEquals(
                "explanation_popup",
                FuelStationParser.extract(popup, "amap-fuel", "screen-ocr-user-driven")
                        .get(0).fuelQuotes.get(0).quoteEntry
        );
    }

    @Test
    public void amapProviderQuotedFormExtractsCpInsideQuotes() {
        // 高德页面底部实际格式：CP 名在引号内。
        List<OcrRow> rows = Arrays.asList(
                row("高德加油", .05f, .05f),
                row("中石油高新加油站", .05f, .12f),
                row("92#汽油 外显价 6.6300元/升", .05f, .20f),
                row("本次由服务商“团油”提供", .05f, .28f),
                row("加油金额 200.00元", .05f, .40f),
                row("优惠金额 20.65元", .05f, .47f),
                row("服务费 3.30元", .05f, .54f),
                row("预计实付 182.65元", .05f, .61f)
        );
        FuelStationRecord station = FuelStationParser.extract(
                rows, "amap-fuel", "screen-ocr-user-driven"
        ).get(0);
        assertEquals("团油", station.providerName);
        assertNotNull(station.providerEvidence);
        assertEquals("团油", station.providerEvidence.optString("text"));
    }

    @Test
    public void providerEvidenceKeepsOnlyNormalizedProviderAndDropsPhoneAndOrderTail() {
        List<OcrRow> rows = Arrays.asList(
                row("高德加油", .05f, .05f),
                row("中石油高新加油站", .05f, .12f),
                row("92#汽油 外显价 6.6300元/升", .05f, .20f),
                row("服务商：测试能源 手机号 " + MOCK_PHONE + " 订单号 AMAP-10003", .05f, .28f),
                row("加油金额 200.00元", .05f, .40f),
                row("优惠金额 20.65元", .05f, .47f),
                row("预计实付 179.35元", .05f, .54f)
        );

        FuelStationRecord station = FuelStationParser.extract(
                rows, "amap-fuel", "screen-ocr-user-driven"
        ).get(0);
        assertEquals("测试能源", station.providerName);
        assertNotNull(station.providerEvidence);
        assertEquals("provider-attribution", station.providerEvidence.optString("kind"));
        assertEquals("测试能源", station.providerEvidence.optString("text"));
        String serializedEvidence = station.providerEvidence.toString();
        assertFalse(serializedEvidence.contains(MOCK_PHONE));
        assertFalse(serializedEvidence.contains("订单"));
        assertFalse(serializedEvidence.contains("AMAP-10003"));

        List<OcrRow> unlabeledPhone = Arrays.asList(
                row("高德加油", .05f, .05f),
                row("中石油高新加油站", .05f, .12f),
                row("92#汽油 外显价 6.6300元/升", .05f, .20f),
                row("服务商：测试能源" + MOCK_PHONE, .05f, .28f)
        );
        FuelStationRecord unsafeProvider = FuelStationParser.extract(
                unlabeledPhone, "amap-fuel", "screen-ocr-user-driven"
        ).get(0);
        assertTrue(unsafeProvider.providerName == null || unsafeProvider.providerName.isEmpty());
        assertTrue(unsafeProvider.providerEvidence == null);
    }

    private static OcrRow row(String value, float x, float y) {
        return new OcrRow(value, .98f, x, y, .72f, .04f);
    }
}
