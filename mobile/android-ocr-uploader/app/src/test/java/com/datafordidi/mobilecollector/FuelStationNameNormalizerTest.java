package com.datafordidi.mobilecollector;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class FuelStationNameNormalizerTest {
    @Test
    public void removesAmapSearchShellWithoutGuessingMissingCharacters() {
        assertEquals(
                "浙江石油塘河供能加油站",
                FuelStationNameNormalizer.normalize("|在浙江石油塘河供加油站附近搜..")
        );
        assertEquals(
                "浙江石油塘河供能加油站",
                FuelStationNameNormalizer.normalize("｜在浙江石油塘河供能加油站附近搜索……")
        );
        assertEquals(
                "壳牌加油站(浙江银湖站)",
                FuelStationNameNormalizer.normalize("在克牌加油站(浙江银湖站)附近搜素")
        );
        assertEquals(
                "壳牌加油站(浙江银湖站)",
                FuelStationNameNormalizer.normalize("く在売牌加油站(浙江银湖站附近搜素")
        );
    }

    @Test
    public void preservesLegitimateStationTextAndInternalPunctuation() {
        assertEquals(
                "在水一方加油站",
                FuelStationNameNormalizer.normalize("在水一方加油站")
        );
        assertEquals(
                "中石化-城东加油站",
                FuelStationNameNormalizer.normalize("中石化-城东加油站")
        );
        assertEquals(
                "在未知加油站附近这是一段很长提示",
                FuelStationNameNormalizer.normalize("在未知加油站附近这是一段很长提示")
        );
        org.junit.Assert.assertTrue(FuelStationNameNormalizer.hasSearchShellNoise(
                "在未知加油站附近这是一段很长提示"
        ));
    }

    @Test
    public void repairsOnlyTheVerifiedMalformedSupplyStationSuffix() {
        assertEquals(
                "浙江石油石马供能加油站",
                FuelStationNameNormalizer.normalize("浙江石油石马供加油站")
        );
        assertEquals(
                "供销社加油站",
                FuelStationNameNormalizer.normalize("供销社加油站")
        );
    }

    @Test
    public void manualSessionIdsAreDistinctPerStationCycle() {
        String first = ManualOcrService.newManualSessionId();
        String second = ManualOcrService.newManualSessionId();
        org.junit.Assert.assertTrue(first.startsWith("manual-ocr-"));
        org.junit.Assert.assertTrue(second.startsWith("manual-ocr-"));
        org.junit.Assert.assertNotEquals(first, second);
    }
}
