package com.datafordidi.mobilecollector;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

@RunWith(RobolectricTestRunner.class)
public class StationSensitiveDataPolicyTest {
    private static final String MOCK_PHONE = "138" + "1234" + "5678";
    private static final String MOCK_ID_CARD = "110105" + "19491231" + "002X";
    private static final String MOCK_BEARER = "Bearer " + "test_" + "credential_12345";
    private static final String MOCK_JWT = "abcdefgh" + "." + "ijklmnop" + "." + "qrstuvwx";
    private static final String MOCK_ASSIGNED_SECRET = "unsafe_" + "credential_123";
    private Context context;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("standalone_ocr_outbox", Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
        context.getSharedPreferences("standalone_ocr_results", Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
        BackfillRetryScheduler.setEnqueuerForTests((ignoredContext, ignoredPolicy, request) -> { });
    }

    @After
    public void tearDown() {
        BackfillRetryScheduler.setEnqueuerForTests(null);
    }

    @Test
    public void acceptsNormalStationAddressNumbersOilGradesAndPrices() throws Exception {
        String address = "陕西省西安市高新区科技二路88号A座，距95号油枪92米，电价0.85元";
        assertFalse(StationSensitiveDataPolicy.isSensitive("高德能源科技二路88号站"));
        assertFalse(StationSensitiveDataPolicy.isSensitive(address));
        assertEquals(address, StationObservationV3.sanitizeAddress(address));

        JSONObject technical = new JSONObject()
                .put("platform", "amap-fuel")
                .put("sourceAgent", "android-ocr-agent")
                .put("screenHash", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
                .put("editId", "12345678-1234-1234-1234-123456789012")
                .put("localKey", "fuel|amap-fuel|西安|测试能源站|manual-backfill|"
                        + "12345678-1234-1234-1234-123456789012|1")
                .put("stationName", "支付宝大厦能源站")
                .put("address", "上海市浦东新区支付宝大厦88号")
                .put("gradeLabel", "92#汽油")
                .put("displayPrice", "6.6300")
                .put("availablePorts", 6)
                .put("busyPorts", 2)
                .put("totalPorts", 8);
        StationSensitiveDataPolicy.requireSafeUserDerived(technical);
        for (String normalText : new String[]{
                "Token能源场站",
                "secret garden能源站",
                "password reset guide",
                "access token service desk",
                "api key management building"
        }) {
            assertFalse(normalText, StationSensitiveDataPolicy.isSensitive(normalText));
            StationSensitiveDataPolicy.requireSafeUserDerived(
                    new JSONObject().put("providerEvidence", new JSONObject().put("text", normalText))
            );
        }
    }

    @Test
    public void rejectsSensitiveLabelsAndHighConfidenceIdentifiers() {
        for (String value : new String[]{
                "联系人手机号 " + MOCK_PHONE,
                "身份证号 " + MOCK_ID_CARD,
                "银行卡号 6222 0212 3456 7890",
                "登录账号 test-user",
                "账户 20260724",
                "验证码 889900",
                "订单号 DIDI-10003",
                "支付号 PAY-10003",
                "密码 abc123"
        }) {
            assertTrue(value, StationSensitiveDataPolicy.isSensitive(value));
        }
        assertTrue(StationSensitiveDataPolicy.isSensitive(MOCK_BEARER));
        assertTrue(StationSensitiveDataPolicy.isSensitive(MOCK_JWT));
        for (String value : new String[]{
                "token=" + MOCK_ASSIGNED_SECRET,
                "access_token: " + MOCK_ASSIGNED_SECRET,
                "access-token=\"" + MOCK_ASSIGNED_SECRET + "\"",
                "api_key='" + MOCK_ASSIGNED_SECRET + "'",
                "api-key=" + MOCK_ASSIGNED_SECRET,
                "secret: " + MOCK_ASSIGNED_SECRET,
                "password=" + MOCK_ASSIGNED_SECRET
        }) {
            assertTrue(value, StationSensitiveDataPolicy.isSensitive(value));
        }
    }

    @Test
    public void recursivelyRejectsNestedProviderEvidenceRawQuoteAndCredentialsWithSafeErrors()
            throws Exception {
        for (JSONObject unsafe : new JSONObject[]{
                nested("providerEvidence", "text", "测试能源 手机号 " + MOCK_PHONE),
                nested("evidence", "text", "订单号 AMAP-10003"),
                nested("raw", "ocr", "登录账户 demo-user"),
                nested("quote", "note", "支付号 PAY-10003"),
                nested("raw", "credential", MOCK_BEARER),
                nested("raw", "credential", MOCK_JWT),
                nested("raw", "credential", "api_key=" + MOCK_ASSIGNED_SECRET)
        }) {
            String serialized = unsafe.toString();
            try {
                StationSensitiveDataPolicy.requireSafeUserDerived(unsafe);
                fail("nested user-derived sensitive text must be rejected");
            } catch (IllegalArgumentException expected) {
                assertTrue(expected.getMessage().contains("安全拒绝"));
                assertFalse(expected.getMessage().contains(MOCK_PHONE));
                assertFalse(expected.getMessage().contains("AMAP-10003"));
                assertFalse(expected.getMessage().contains("demo-user"));
                assertFalse(expected.getMessage().contains("PAY-10003"));
                assertFalse(expected.getMessage().contains(MOCK_BEARER));
                assertFalse(expected.getMessage().contains(MOCK_JWT));
                assertFalse(expected.getMessage().contains(MOCK_ASSIGNED_SECRET));
                assertFalse(expected.getMessage().contains(serialized));
            }
        }
    }

    @Test
    public void rejectsSensitiveNameOrAddressBeforeOutboxPersistence() throws Exception {
        DidiLocalStationParser.StationRecord sensitiveName = station(
                "账号 " + MOCK_PHONE,
                "西安市科技路88号"
        );
        assertEnqueueRejected(sensitiveName);

        DidiLocalStationParser.StationRecord sensitiveAddress = station(
                "正常能源场站",
                "西安市科技路88号 联系电话 " + MOCK_PHONE
        );
        assertEnqueueRejected(sensitiveAddress);

        assertTrue(OutboxStore.pending(context).isEmpty());
    }

    @Test
    public void rejectsSensitiveQueueMutationAtProductionUploadEntryWithoutNetwork() throws Exception {
        DidiLocalStationParser.StationRecord station = station("正常能源场站", "西安市科技路88号");
        JSONObject observation = ObservationEnvelope.charging(station, "西安");
        observation.getJSONObject("stationObservation")
                .put("address", "西安市科技路88号 手机号 " + MOCK_PHONE);
        JSONObject batch = batch(observation);

        try {
            new StationSyncClient().upload(context, batch);
            fail("mutated sensitive payload must not reach network setup");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("场站地址"));
            assertFalse(expected.getMessage().contains(MOCK_PHONE));
        }
    }

    @Test
    public void localStoreRejectsNestedChargingAndFuelTextBeforePersistence() throws Exception {
        DidiLocalStationParser.StationRecord charging = station(
                "正常能源场站",
                "上海市浦东新区支付宝大厦88号"
        );
        charging.priceEvidence = new JSONArray().put(
                new JSONObject().put("text", "订单号 DIDI-10003")
        );
        assertTrue(LocalStationStore.upsert(
                context,
                "charging-sensitive-session",
                1,
                "上海",
                Collections.singletonList(charging)
        ).isEmpty());
        assertTrue(LocalStationStore.list(context).isEmpty());

        FuelStationRecord fuel = FuelQuoteTest.stationWithQuote();
        fuel.providerEvidence = new JSONObject()
                .put("kind", "provider-attribution")
                .put("text", "测试服务商 手机号 " + MOCK_PHONE);
        assertTrue(LocalStationStore.upsertFuel(
                context,
                "fuel-sensitive-session",
                2,
                "西安",
                Collections.singletonList(fuel)
        ).isEmpty());
        assertTrue(LocalStationStore.list(context).isEmpty());
    }

    @Test
    public void outboxFuelGateRejectsNestedProviderEvidenceBeforePersistence() throws Exception {
        FuelStationRecord fuel = FuelQuoteTest.stationWithQuote();
        fuel.providerEvidence = new JSONObject()
                .put("kind", "provider-attribution")
                .put("text", "测试服务商 订单号 AMAP-10003");
        try {
            OutboxStore.enqueueFuel(
                    context,
                    "fuel-sensitive-session",
                    2,
                    "0123456789abcdef0123456789abcdef",
                    "amap-fuel",
                    "西安",
                    Collections.singletonList("fuel-local-key"),
                    Collections.singletonList(fuel),
                    true
            );
            fail("nested provider evidence must not enter outbox");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("安全拒绝"));
            assertFalse(expected.getMessage().contains("AMAP-10003"));
        }
        assertTrue(OutboxStore.pending(context).isEmpty());
    }

    @Test
    public void uploadGateRejectsNestedRawCredentialBeforeConfigurationOrNetwork() throws Exception {
        JSONObject observation = ObservationEnvelope.charging(
                station("正常能源场站", "上海市浦东新区支付宝大厦88号"),
                "上海"
        );
        observation.getJSONObject("chargingObservation")
                .getJSONObject("raw")
                .put("trace", MOCK_JWT);
        try {
            new StationSyncClient().upload(context, batch(observation));
            fail("nested credential must not reach upload configuration or network");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("安全拒绝"));
            assertFalse(expected.getMessage().contains(MOCK_JWT));
        }
        assertTrue(OutboxStore.pending(context).isEmpty());
    }

    private void assertEnqueueRejected(DidiLocalStationParser.StationRecord station) throws Exception {
        try {
            OutboxStore.enqueue(
                    context,
                    "sensitive-session",
                    1,
                    "sensitive-screen",
                    "didi-charging",
                    "西安",
                    Collections.singletonList("local-key"),
                    Collections.singletonList(station)
            );
            fail("sensitive station data must not enter outbox");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("敏感信息"));
        }
    }

    private static JSONObject batch(JSONObject observation) throws Exception {
        return new JSONObject()
                .put("schemaVersion", StationObservationV3.SCHEMA_VERSION)
                .put("stationType", "charging")
                .put("batchId", "sensitive-batch")
                .put("sessionId", "sensitive-session")
                .put("pageIndex", 1)
                .put("screenHash", "sensitive-screen")
                .put("platform", "didi-charging")
                .put("city", "西安")
                .put("capturedAt", "2026-07-24T08:30:00Z")
                .put("observations", new JSONArray().put(observation));
    }

    private static JSONObject nested(String parentKey, String childKey, String value)
            throws Exception {
        return new JSONObject().put(parentKey, new JSONObject().put(childKey, value));
    }

    private static DidiLocalStationParser.StationRecord station(String name, String address) {
        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.platform = "didi-charging";
        station.stationName = name;
        station.address = address;
        station.capturedAt = "2026-07-24T08:30:00Z";
        station.sourceStage = "screen-ocr-user-driven";
        return station;
    }
}
