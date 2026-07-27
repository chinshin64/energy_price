package com.datafordidi.mobilecollector;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

public class FuelProviderExtractorTest {

    @Test
    public void extractsAmapPaymentAttribution() {
        FuelProviderExtractor.Result result = FuelProviderExtractor.extract(Collections.singletonList(
                row("本次油服务商团油提供")
        ));

        assertTrue(result.present());
        assertEquals("团油", result.name);
    }

    @Test
    public void normalizesRepeatedDidiBrandOnlyWithAttributionEvidence() {
        FuelProviderExtractor.Result result = FuelProviderExtractor.extract(Collections.singletonList(
                row("本次由服务商滴加油提供")
        ));

        assertTrue(result.present());
        assertEquals("滴滴加油", result.name);
    }

    @Test
    public void removesOcrDamagedProviderPrefixWithoutLosingKnownBrand() {
        FuelProviderExtractor.Result result = FuelProviderExtractor.extract(Collections.singletonList(
                row("本次油服务商服商滴滴加油提供")
        ));

        assertTrue(result.present());
        assertEquals("滴滴加油", result.name);
    }

    @Test
    public void rejectsInvoiceCustomerServiceTextAsProvider() {
        FuelProviderExtractor.Result result = FuelProviderExtractor.extract(Arrays.asList(
                row("服务费1服务商开票联系客服"),
                row("油费1油站开票当场索取")
        ));

        assertFalse(result.present());
    }

    private static OcrRow row(String text) {
        return new OcrRow(text, 1f, 0.05f, 0.8f, 0.9f, 0.03f);
    }
}
