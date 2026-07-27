package com.datafordidi.mobilecollector;

import org.junit.Test;

import java.math.BigDecimal;
import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class AmapFuelSessionReconcilerTest {

    @Test
    public void sameStationTwoPaymentPricesBecome92And95WithoutDefaultingFirstPage() {
        AmapFuelSessionReconciler reconciler = new AmapFuelSessionReconciler();
        List<OcrRow> lowerRows = paymentRows("¥7.19/L 加200省¥5.41", "¥195.46");
        List<FuelStationRecord> lowerParsed = parse(lowerRows);

        AmapFuelSessionReconciler.Result first = reconciler.reconcile(
                "amap-fuel", lowerRows, lowerParsed
        );
        assertTrue(first.waitingForPair);
        assertTrue(first.stations.isEmpty());
        assertNotNull(first.pendingPreview);
        assertEquals("浙江石油塘河供能加油站", first.pendingPreview.stationName);
        assertEquals(new BigDecimal("7.19"), first.pendingPreview.displayPrice);
        assertEquals(new BigDecimal("5.41"), first.pendingPreview.grossDiscount);
        assertEquals(new BigDecimal("0.87"), first.pendingPreview.serviceFee);
        assertEquals(new BigDecimal("195.46"), first.pendingPreview.payableAmount);
        assertEquals("团油", first.pendingPreview.providerName);

        List<OcrRow> higherRows = paymentRows("¥7.66/L 加200省¥5.09", "¥195.72");
        AmapFuelSessionReconciler.Result second = reconciler.reconcile(
                "amap-fuel", higherRows, parse(higherRows)
        );
        assertFalse(second.waitingForPair);
        assertEquals(1, second.stations.size());
        assertTrue(second.pendingPreview == null);

        FuelStationRecord station = second.stations.get(0);
        assertEquals("amap-payment-display-price-ranking", station.localParser);
        assertEquals(2, station.fuelOffers.size());
        assertEquals(2, station.fuelQuotes.size());

        FuelOffer offer92 = station.offerForGrade("92");
        FuelOffer offer95 = station.offerForGrade("95");
        assertNotNull(offer92);
        assertNotNull(offer95);
        assertEquals(new BigDecimal("7.19"), offer92.displayPrice);
        assertEquals(new BigDecimal("7.66"), offer95.displayPrice);

        FuelQuote quote92 = quoteForGrade(station, "92");
        FuelQuote quote95 = quoteForGrade(station, "95");
        assertEquals(new BigDecimal("0.87"), quote92.serviceFee);
        assertEquals(new BigDecimal("0.81"), quote95.serviceFee);
        assertFalse(quote92.needsReview);
        assertFalse(quote95.needsReview);
    }

    @Test
    public void cachedDetailGradeWinsBeforeDisplayPriceRanking() {
        AmapFuelSessionReconciler reconciler = new AmapFuelSessionReconciler();
        List<OcrRow> detailRows = Arrays.asList(
                row("浙江石油塘河供能加油站", .04f, .10f),
                row("92# 优惠¥0.20/L", .04f, .20f),
                row("¥7.19/L", .04f, .25f),
                row("油站价¥7.39/L", .55f, .25f)
        );
        AmapFuelSessionReconciler.Result detail = reconciler.reconcile(
                "amap-fuel", detailRows, parse(detailRows)
        );
        assertTrue(detail.waitingForPair);
        assertTrue(detail.stations.isEmpty());

        List<OcrRow> paymentRows = paymentRows("¥7.19/L 加200省¥5.41", "¥195.46");
        AmapFuelSessionReconciler.Result payment = reconciler.reconcile(
                "amap-fuel", paymentRows, parse(paymentRows)
        );
        assertFalse(payment.waitingForPair);
        assertEquals(1, payment.stations.size());
        FuelStationRecord station = payment.stations.get(0);
        assertEquals(1, station.fuelOffers.size());
        assertNotNull(station.offerForGrade("92"));
        assertEquals("92", station.fuelQuotes.get(0).gradeCode);
        assertEquals("amap-detail-payment-reconciled", station.localParser);
    }

    @Test
    public void resetDropsPreviousStationDetailCache() {
        AmapFuelSessionReconciler reconciler = new AmapFuelSessionReconciler();
        List<OcrRow> detailRows = Arrays.asList(
                row("浙江石油塘河供能加油站", .04f, .10f),
                row("92# 优惠¥0.20/L", .04f, .20f),
                row("¥7.19/L", .04f, .25f),
                row("油站价¥7.39/L", .55f, .25f)
        );
        reconciler.reconcile("amap-fuel", detailRows, parse(detailRows));

        reconciler.reset();
        List<OcrRow> paymentRows = paymentRows("¥7.19/L 加200省¥5.41", "¥195.46");
        AmapFuelSessionReconciler.Result payment = reconciler.reconcile(
                "amap-fuel",
                paymentRows,
                parse(paymentRows)
        );

        assertTrue(payment.waitingForPair);
        assertTrue(payment.stations.isEmpty());
    }

    @Test
    public void duplicateSinglePriceAndNonAmapPlatformNeverTriggerRanking() {
        AmapFuelSessionReconciler reconciler = new AmapFuelSessionReconciler();
        List<OcrRow> rows = paymentRows("¥7.19/L 加200省¥5.41", "¥195.46");
        assertTrue(reconciler.reconcile("amap-fuel", rows, parse(rows)).stations.isEmpty());
        AmapFuelSessionReconciler.Result duplicate = reconciler.reconcile(
                "amap-fuel", rows, parse(rows)
        );
        assertTrue(duplicate.waitingForPair);
        assertTrue(duplicate.stations.isEmpty());

        AmapFuelSessionReconciler.Result other = reconciler.reconcile(
                "tuanyou", rows, parse(rows)
        );
        assertEquals(parse(rows).size(), other.stations.size());
    }

    @Test
    public void tinyGapAndThirdUnknownPriceAreNotAutoAssigned() {
        AmapFuelSessionReconciler tinyGap = new AmapFuelSessionReconciler();
        List<OcrRow> first = paymentRows("¥7.19/L 加200省¥5.41", "¥195.46");
        List<OcrRow> almostSame = paymentRows("¥7.20/L 加200省¥5.40", "¥195.47");
        assertTrue(tinyGap.reconcile("amap-fuel", first, parse(first)).stations.isEmpty());
        AmapFuelSessionReconciler.Result unresolved = tinyGap.reconcile(
                "amap-fuel", almostSame, parse(almostSame)
        );
        assertTrue(unresolved.waitingForPair);
        assertTrue(unresolved.stations.isEmpty());

        AmapFuelSessionReconciler ranked = new AmapFuelSessionReconciler();
        List<OcrRow> second = paymentRows("¥7.66/L 加200省¥5.09", "¥195.72");
        ranked.reconcile("amap-fuel", first, parse(first));
        assertEquals(1, ranked.reconcile("amap-fuel", second, parse(second)).stations.size());
        List<OcrRow> third = paymentRows("¥8.20/L 加200省¥4.00", "¥197.00");
        AmapFuelSessionReconciler.Result rejectedThird = ranked.reconcile(
                "amap-fuel", third, parse(third)
        );
        assertTrue(rejectedThird.waitingForPair);
        assertTrue(rejectedThird.stations.isEmpty());
    }

    @Test
    public void paymentPreviewRecoversDisplayPriceWhenUnitIsMissedByOcr() {
        AmapFuelSessionReconciler reconciler = new AmapFuelSessionReconciler();
        List<OcrRow> rows = Arrays.asList(
                row("浙江石油塘河供能加油站", .04f, .10f),
                row("¥7.66加200省¥5.09", .04f, .16f),
                row("比油站价优惠¥4.28", .04f, .76f),
                row("本次油服务商团油提供", .18f, .83f)
        );

        AmapFuelSessionReconciler.Result result =
                reconciler.reconcile("amap-fuel", rows, parse(rows));

        assertTrue(result.waitingForPair);
        assertNotNull(result.pendingPreview);
        assertEquals(new BigDecimal("7.66"), result.pendingPreview.displayPrice);
    }

    @Test
    public void guidedCaptureUsesRequestedGradeWithoutWaitingForPricePair() {
        AmapFuelSessionReconciler reconciler = new AmapFuelSessionReconciler();
        List<OcrRow> rows = paymentRows("¥7.19/L 加200省¥5.41", "¥195.46");

        AmapFuelSessionReconciler.Result result =
                reconciler.reconcileGuided("amap-fuel", rows, parse(rows), "92");

        assertFalse(result.waitingForPair);
        assertEquals(1, result.stations.size());
        assertNotNull(result.stations.get(0).offerForGrade("92"));
        assertEquals("amap-guided-92", result.stations.get(0).localParser);
    }

    @Test
    public void guidedCaptureDoesNotCompleteWithoutPaymentProviderEvidence() {
        AmapFuelSessionReconciler reconciler = new AmapFuelSessionReconciler();
        List<OcrRow> rows = Arrays.asList(
                row("浙江石油塘河供能加油站", .04f, .10f),
                row("¥7.19/L 加200省¥5.41", .04f, .16f),
                row("比油站价优惠¥4.54", .04f, .76f)
        );

        AmapFuelSessionReconciler.Result result =
                reconciler.reconcileGuided("amap-fuel", rows, parse(rows), "92");

        assertTrue(result.waitingForPair);
        assertTrue(result.stations.isEmpty());
        assertNotNull(result.pendingPreview);
    }

    @Test
    public void guidedCaptureDoesNotUploadWhenGalleryHidesPaymentFooter() {
        AmapFuelSessionReconciler reconciler = new AmapFuelSessionReconciler();
        List<OcrRow> rows = Arrays.asList(
                row("95#", .05f, .05f),
                row("中海联石油城西加油站", .05f, .10f),
                row("¥7.08/L", .05f, .15f),
                row("加200", .23f, .15f),
                row("省¥19.85", .36f, .15f),
                row("购超值神券包", .06f, .23f),
                row("¥3.5", .78f, .25f),
                row("12元×2张", .17f, .34f),
                row("满200减12", .17f, .39f),
                row("3元", .62f, .34f),
                row("满30减3", .59f, .39f),
                row("500万油品保障7天", .52f, .61f),
                row("送200-8加油券×1张", .52f, .66f),
                row("¥1/份", .61f, .72f),
                row("本次由服务商", .22f, .88f),
                row("中能光和", .48f, .88f),
                row("提供", .65f, .88f)
        );

        AmapFuelSessionReconciler.Result result =
                reconciler.reconcileGuided("amap-fuel", rows, parse(rows), "95");

        assertTrue(result.waitingForPair);
        assertTrue(result.stations.isEmpty());
        assertNotNull(result.pendingPreview);
        assertEquals(new BigDecimal("19.85"), result.pendingPreview.grossDiscount);
        assertNull(result.pendingPreview.serviceFee);
        assertNull(result.pendingPreview.payableAmount);
    }

    private static List<FuelStationRecord> parse(List<OcrRow> rows) {
        return FuelStationParser.extract(rows, "amap-fuel", "screen-ocr-user-driven");
    }

    private static List<OcrRow> paymentRows(String priceAndDiscount, String payable) {
        return Arrays.asList(
                row("浙江石油塘河供能加油站", .04f, .10f),
                row(priceAndDiscount, .04f, .16f),
                row("本次油服务商团油提供", .18f, .83f),
                row(payable, .04f, .94f)
        );
    }

    private static FuelQuote quoteForGrade(FuelStationRecord station, String grade) {
        for (FuelQuote quote : station.fuelQuotes) {
            if (quote != null && grade.equals(quote.gradeCode)) return quote;
        }
        throw new AssertionError("missing quote for grade " + grade);
    }

    private static OcrRow row(String text, float x, float y) {
        return new OcrRow(text, .98f, x, y, .72f, .04f);
    }
}
