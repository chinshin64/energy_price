package com.chinshin.energyprice.ui;

import android.content.Context;

import com.chinshin.energyprice.data.CaptureRecord;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public final class CsvExporter {
    private CsvExporter() {}

    public static File export(Context context, List<CaptureRecord> records) throws Exception {
        File dir = new File(context.getCacheDir(), "exports");
        if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("cannot create export directory");
        String suffix = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.CHINA).format(new Date());
        File file = new File(dir, "energy-price-" + suffix + ".csv");
        try (OutputStreamWriter writer = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) {
            writer.write('\uFEFF');
            writer.write("采集时间,油站名,油号,加油金额,油站价,优惠价,原价,优惠金额,服务费,实付金额,CP\n");
            for (CaptureRecord r : records) {
                writer.write(csv(StationDisplayFormatter.timeLine(r)) + ",");
                writer.write(csv(r.stationName) + ",");
                writer.write(csv(r.gradeCode) + ",");
                writer.write(r.amountYuan + ",");
                writer.write(format(r.stationPrice) + ",");
                writer.write(format(r.displayPrice) + ",");
                writer.write(format(r.listPrice) + ",");
                writer.write(format(r.discountAmount) + ",");
                writer.write(format(r.serviceFee) + ",");
                writer.write(r.payableAmount == null ? "" : format(r.payableAmount));
                writer.write("," + csv(r.providerName) + "\n");
            }
        }
        return file;
    }

    private static String csv(String value) {
        if (value == null) return "";
        return '"' + value.replace("\"", "\"\"") + '"';
    }

    private static String format(double value) {
        return String.format(Locale.US, "%.2f", value);
    }
}
