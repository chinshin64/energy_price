package com.chinshin.energyprice.capture;

import java.util.Locale;

public final class FuelCapture {
    public String stationName;
    public String gradeCode;
    public String gradeLabel;
    public boolean gradeExplicit;
    public Integer amountYuan;
    public Double stationPrice;
    public Double displayPrice;
    public Double listPrice;
    public Double discountAmount;
    public Double discountPerLiter;
    public Double serviceFee;
    public Double payableAmount;
    public String providerName;
    public String providerEvidenceText;
    public String rawText;
    public String screenHash;
    public boolean paymentPage;
    public long capturedAtEpochMs;

    public FuelCapture copy() {
        FuelCapture copy = new FuelCapture();
        copy.stationName = stationName;
        copy.gradeCode = gradeCode;
        copy.gradeLabel = gradeLabel;
        copy.gradeExplicit = gradeExplicit;
        copy.amountYuan = amountYuan;
        copy.stationPrice = stationPrice;
        copy.displayPrice = displayPrice;
        copy.listPrice = listPrice;
        copy.discountAmount = discountAmount;
        copy.discountPerLiter = discountPerLiter;
        copy.serviceFee = serviceFee;
        copy.payableAmount = payableAmount;
        copy.providerName = providerName;
        copy.providerEvidenceText = providerEvidenceText;
        copy.rawText = rawText;
        copy.screenHash = screenHash;
        copy.paymentPage = paymentPage;
        copy.capturedAtEpochMs = capturedAtEpochMs;
        return copy;
    }

    public FuelCapture merge(FuelCapture newer) {
        if (newer == null) return copy();
        FuelCapture out = copy();
        out.stationName = prefer(newer.stationName, out.stationName);
        out.gradeCode = prefer(newer.gradeCode, out.gradeCode);
        out.gradeLabel = prefer(newer.gradeLabel, out.gradeLabel);
        out.gradeExplicit = out.gradeExplicit || newer.gradeExplicit;
        out.amountYuan = newer.amountYuan != null ? newer.amountYuan : out.amountYuan;
        out.stationPrice = newer.stationPrice != null ? newer.stationPrice : out.stationPrice;
        out.displayPrice = newer.displayPrice != null ? newer.displayPrice : out.displayPrice;
        out.listPrice = newer.listPrice != null ? newer.listPrice : out.listPrice;
        out.discountAmount = newer.discountAmount != null ? newer.discountAmount : out.discountAmount;
        out.discountPerLiter = newer.discountPerLiter != null ? newer.discountPerLiter : out.discountPerLiter;
        out.serviceFee = newer.serviceFee != null ? newer.serviceFee : out.serviceFee;
        out.payableAmount = newer.payableAmount != null ? newer.payableAmount : out.payableAmount;
        out.providerName = prefer(newer.providerName, out.providerName);
        out.providerEvidenceText = prefer(newer.providerEvidenceText, out.providerEvidenceText);
        out.rawText = prefer(newer.rawText, out.rawText);
        out.screenHash = prefer(newer.screenHash, out.screenHash);
        out.paymentPage = out.paymentPage || newer.paymentPage;
        out.capturedAtEpochMs = Math.max(out.capturedAtEpochMs, newer.capturedAtEpochMs);
        return out;
    }

    public boolean isCompleteForSubmission() {
        return notBlank(stationName)
                && ("92".equals(gradeCode) || "95".equals(gradeCode))
                && amountYuan != null && amountYuan == 200
                && stationPrice != null
                && displayPrice != null
                && discountAmount != null
                && serviceFee != null
                && notBlank(providerName)
                && notBlank(providerEvidenceText)
                && paymentPage;
    }

    public Double resolvedStationPrice() {
        if (stationPrice != null) return stationPrice;
        return listPrice;
    }

    public Double resolvedDisplayPrice() {
        if (displayPrice != null) return displayPrice;
        if (stationPrice != null && discountPerLiter != null) {
            return round2(stationPrice - discountPerLiter);
        }
        return null;
    }

    public Double resolvedListPrice() {
        if (listPrice != null) return listPrice;
        return stationPrice;
    }

    public String stableIdentity() {
        return String.format(Locale.US, "%s|%s|%d|%.2f|%.2f|%.2f|%.2f|%s",
                stationName == null ? "" : stationName,
                gradeCode == null ? "" : gradeCode,
                amountYuan == null ? 0 : amountYuan,
                stationPrice == null ? 0d : stationPrice,
                displayPrice == null ? 0d : displayPrice,
                discountAmount == null ? 0d : discountAmount,
                serviceFee == null ? 0d : serviceFee,
                providerName == null ? "" : providerName);
    }

    private static String prefer(String first, String second) {
        return notBlank(first) ? first : second;
    }

    private static boolean notBlank(String value) {
        return value != null && !value.trim().isEmpty();
    }

    private static double round2(double value) {
        return Math.round(value * 100d) / 100d;
    }
}
