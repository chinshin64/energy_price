package com.chinshin.energyprice.data;

public final class CaptureRecord {
    public long id;
    public String stationName;
    public String gradeCode;
    public int amountYuan;
    public double stationPrice;
    public double displayPrice;
    public double listPrice;
    public double discountAmount;
    public double serviceFee;
    public Double payableAmount;
    public String providerName;
    public long capturedAt;
    public String stableIdentity;
    public String idempotencyKey;
    public String payloadJson;
    public int syncState;
    public int attemptCount;
    public String lastError;
}
