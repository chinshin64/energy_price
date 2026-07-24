package com.datafordidi.mobilecollector;

import android.content.Context;
import android.location.Location;
import android.location.LocationManager;
import android.location.provider.ProviderProperties;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;

import java.util.HashMap;
import java.util.Map;

/**
 * Uses LocationManager.addTestProvider / setTestProviderLocation to mock GPS position.
 * Mocks BOTH "gps" and "network" providers so fused always merges our coordinates.
 * Requires ACCESS_MOCK_LOCATION permission + the app selected as "Mock location app"
 * in Developer Options.
 */
public final class LocationMockHelper {
    private static final String TAG = "DataForDidiLocMock";
    private static final String PROVIDER_GPS = LocationManager.GPS_PROVIDER;
    private static final String PROVIDER_NETWORK = LocationManager.NETWORK_PROVIDER;
    private static final String[] ALL_PROVIDERS = {PROVIDER_GPS, PROVIDER_NETWORK};
    private static final long UPDATE_INTERVAL_MS = 5000L;

    private static final Map<String, double[]> CITY_COORDS = new HashMap<>();

    static {
        // latitude, longitude
        CITY_COORDS.put("上海", new double[]{31.2304, 121.4737});
        CITY_COORDS.put("北京", new double[]{39.9042, 116.4074});
        CITY_COORDS.put("广州", new double[]{23.1291, 113.2644});
        CITY_COORDS.put("深圳", new double[]{22.5431, 114.0579});
        CITY_COORDS.put("武汉", new double[]{30.5928, 114.3055});
        CITY_COORDS.put("西安", new double[]{34.3416, 108.9398});
        CITY_COORDS.put("青岛", new double[]{36.0671, 120.3826});
    }

    private static final Map<String, double[]> LANDMARK_COORDS = new HashMap<>();

    static {
        // 上海地标
        LANDMARK_COORDS.put("上海大宁国际", new double[]{31.278, 121.452});
        LANDMARK_COORDS.put("上海静安大悦城", new double[]{31.241, 121.470});
        LANDMARK_COORDS.put("上海镇坪路", new double[]{31.254, 121.431});
        LANDMARK_COORDS.put("上海宜山路", new double[]{31.192, 121.428});
        LANDMARK_COORDS.put("上海杨浦滨江", new double[]{31.271, 121.526});
        LANDMARK_COORDS.put("上海江湾体育场", new double[]{31.306, 121.507});
        LANDMARK_COORDS.put("上海龙阳路", new double[]{31.203, 121.557});
        LANDMARK_COORDS.put("上海前滩太古里", new double[]{31.155, 121.479});
        LANDMARK_COORDS.put("上海世博源", new double[]{31.187, 121.488});
        LANDMARK_COORDS.put("上海莘庄", new double[]{31.107, 121.377});
        LANDMARK_COORDS.put("上海人民广场", new double[]{31.231, 121.474});
        LANDMARK_COORDS.put("上海南京西路", new double[]{31.230, 121.457});
        LANDMARK_COORDS.put("上海静安寺", new double[]{31.225, 121.446});
        LANDMARK_COORDS.put("上海陆家嘴", new double[]{31.241, 121.502});
        LANDMARK_COORDS.put("上海世纪大道", new double[]{31.232, 121.516});
        LANDMARK_COORDS.put("上海徐家汇", new double[]{31.196, 121.437});
        LANDMARK_COORDS.put("上海中山公园", new double[]{31.220, 121.416});
        LANDMARK_COORDS.put("上海虹桥站", new double[]{31.194, 121.318});
        LANDMARK_COORDS.put("上海打浦桥", new double[]{31.208, 121.469});
        LANDMARK_COORDS.put("上海五角场", new double[]{31.300, 121.518});
        LANDMARK_COORDS.put("上海淮海中路", new double[]{31.218, 121.469});
        LANDMARK_COORDS.put("上海新天地", new double[]{31.218, 121.474});
        LANDMARK_COORDS.put("上海豫园", new double[]{31.228, 121.492});
        LANDMARK_COORDS.put("上海火车站", new double[]{31.251, 121.455});
        LANDMARK_COORDS.put("上海曹家渡", new double[]{31.229, 121.431});
        LANDMARK_COORDS.put("上海天山路", new double[]{31.215, 121.412});
        LANDMARK_COORDS.put("上海北外滩", new double[]{31.252, 121.497});
        LANDMARK_COORDS.put("上海浦东八佰伴", new double[]{31.232, 121.522});
        LANDMARK_COORDS.put("上海漕河泾", new double[]{31.167, 121.399});
        LANDMARK_COORDS.put("上海南站", new double[]{31.155, 121.432});
        // 北京地标
        LANDMARK_COORDS.put("北京国贸", new double[]{39.909, 116.461});
        LANDMARK_COORDS.put("北京三里屯", new double[]{39.934, 116.455});
        LANDMARK_COORDS.put("北京朝阳门", new double[]{39.921, 116.434});
        LANDMARK_COORDS.put("北京东直门", new double[]{39.941, 116.435});
        LANDMARK_COORDS.put("北京西单", new double[]{39.912, 116.374});
        LANDMARK_COORDS.put("北京金融街", new double[]{39.913, 116.360});
        LANDMARK_COORDS.put("北京站", new double[]{39.905, 116.427});
        LANDMARK_COORDS.put("北京大望路", new double[]{39.906, 116.476});
        LANDMARK_COORDS.put("北京中关村", new double[]{39.983, 116.310});
        LANDMARK_COORDS.put("北京望京SOHO", new double[]{39.997, 116.483});
        LANDMARK_COORDS.put("北京朝阳大悦城", new double[]{39.920, 116.519});
        LANDMARK_COORDS.put("北京亮马桥", new double[]{39.949, 116.463});
        LANDMARK_COORDS.put("北京双井", new double[]{39.896, 116.461});
        LANDMARK_COORDS.put("北京崇文门", new double[]{39.897, 116.422});
        LANDMARK_COORDS.put("北京宣武门", new double[]{39.901, 116.374});
        LANDMARK_COORDS.put("北京五道口", new double[]{39.993, 116.338});
        LANDMARK_COORDS.put("北京魏公村", new double[]{39.957, 116.326});
        LANDMARK_COORDS.put("北京四惠", new double[]{39.909, 116.496});
        LANDMARK_COORDS.put("北京牡丹园", new double[]{39.976, 116.369});
        LANDMARK_COORDS.put("北京丽泽商务区", new double[]{39.864, 116.342});
        // 广州地标
        LANDMARK_COORDS.put("广州珠江新城", new double[]{23.122, 113.324});
        LANDMARK_COORDS.put("广州体育西路", new double[]{23.129, 113.322});
        LANDMARK_COORDS.put("广州天河城", new double[]{23.131, 113.323});
        LANDMARK_COORDS.put("广州正佳广场", new double[]{23.131, 113.327});
        LANDMARK_COORDS.put("广州岗顶", new double[]{23.137, 113.340});
        LANDMARK_COORDS.put("广州石牌桥", new double[]{23.134, 113.336});
        LANDMARK_COORDS.put("广州猎德", new double[]{23.117, 113.330});
        LANDMARK_COORDS.put("广州花城广场", new double[]{23.121, 113.326});
        LANDMARK_COORDS.put("广州广州塔", new double[]{23.107, 113.324});
        LANDMARK_COORDS.put("广州琶洲", new double[]{23.100, 113.368});
        LANDMARK_COORDS.put("广州客村", new double[]{23.098, 113.318});
        LANDMARK_COORDS.put("广州海珠广场", new double[]{23.115, 113.267});
        LANDMARK_COORDS.put("广州北京路", new double[]{23.122, 113.272});
        LANDMARK_COORDS.put("广州公园前", new double[]{23.129, 113.266});
        LANDMARK_COORDS.put("广州越秀公园", new double[]{23.142, 113.265});
        LANDMARK_COORDS.put("广州淘金", new double[]{23.136, 113.287});
        LANDMARK_COORDS.put("广州区庄", new double[]{23.132, 113.302});
        LANDMARK_COORDS.put("广州东山口", new double[]{23.126, 113.290});
        LANDMARK_COORDS.put("广州杨箕", new double[]{23.127, 113.311});
        LANDMARK_COORDS.put("广州广州东站", new double[]{23.151, 113.326});
        LANDMARK_COORDS.put("广州林和西", new double[]{23.143, 113.324});
        LANDMARK_COORDS.put("广州五山", new double[]{23.154, 113.348});
        LANDMARK_COORDS.put("广州员村", new double[]{23.121, 113.366});
        LANDMARK_COORDS.put("广州车陂南", new double[]{23.118, 113.392});
        LANDMARK_COORDS.put("广州黄埔大道", new double[]{23.128, 113.361});
        LANDMARK_COORDS.put("广州江南西", new double[]{23.097, 113.276});
        LANDMARK_COORDS.put("广州昌岗", new double[]{23.088, 113.281});
        LANDMARK_COORDS.put("广州中山大学", new double[]{23.103, 113.295});
        LANDMARK_COORDS.put("广州芳村", new double[]{23.098, 113.235});
        LANDMARK_COORDS.put("广州白云公园", new double[]{23.178, 113.273});
    }

    private Context appContext;
    private LocationManager locationManager;
    private HandlerThread updateThread;
    private Handler updateHandler;
    private double currentLat;
    private double currentLng;
    private float currentAccuracy = 5.0f;
    private boolean running;
    /** 最近一次失败原因；启动成功时清空，供调用方回传给前端定位修复指引 */
    private String lastError;
    /** track which providers we've added, so we can remove them on stop */
    private final java.util.Set<String> addedProviders = new java.util.HashSet<>();

    private LocationMockHelper() {
    }

    private static final class Holder {
        static final LocationMockHelper INSTANCE = new LocationMockHelper();
    }

    public static LocationMockHelper getInstance() {
        return Holder.INSTANCE;
    }

    /**
     * Initialize with an application context, which is safe to call from any thread.
     * Call this once in Application.onCreate() or Service.onCreate().
     */
    public synchronized void init(Context context) {
        if (appContext == null && context != null) {
            appContext = context.getApplicationContext();
        }
    }

    /**
     * Start mocking GPS location with explicit coordinates.
     * If lat/lng are both valid (non-zero), use them directly.
     * Otherwise fallback to keyword-based lookup (landmark -> city).
     */
    public synchronized void startMockLocation(Context context, String keyword, double lat, double lng) {
        startMockLocation(context, keyword, lat, lng, 5.0f);
    }

    public synchronized void startMockLocation(Context context, String keyword, double lat, double lng, float accuracy) {
        stopInternal();
        lastError = null;
        currentAccuracy = Math.max(1.0f, Math.min(1000.0f, accuracy));
        boolean coordinateProvided = lat != 0.0 || lng != 0.0;
        if (coordinateProvided && !isValidCoordinate(lat, lng)) {
            lastError = "坐标非法，无法设置模拟定位";
            Log.w(TAG, "startMockLocation: invalid explicit coordinates");
            return;
        }
        if (isValidCoordinate(lat, lng)) {
            // 服务端已解析好坐标，直接使用
            currentLat = lat;
            currentLng = lng;
            Log.i(TAG, "startMockLocation: using server-provided coords lat=" + lat + " lng=" + lng);
        } else {
            // fallback: keyword 查本地表
            if (keyword == null || keyword.isEmpty()) {
                lastError = "未提供坐标且关键词为空，无法设置模拟定位";
                Log.w(TAG, "startMockLocation: no coords and keyword is null/empty, skip");
                return;
            }
            double[] coords = LANDMARK_COORDS.get(keyword);
            if (coords == null) {
                coords = resolveCityCoords(keyword);
            }
            if (coords == null) {
                lastError = "未找到关键词对应的坐标：" + keyword;
                Log.w(TAG, "startMockLocation: no coordinates for keyword=" + keyword);
                return;
            }
            currentLat = coords[0];
            currentLng = coords[1];
            Log.i(TAG, "startMockLocation: using local lookup for keyword=" + keyword + " lat=" + currentLat + " lng=" + currentLng);
        }

        if (locationManager == null) {
            if (appContext == null) {
                lastError = "LocationMockHelper 未初始化";
                Log.e(TAG, "LocationMockHelper not initialized - call init() first");
                return;
            }
            locationManager = (LocationManager) appContext.getSystemService(Context.LOCATION_SERVICE);
            if (locationManager == null) {
                lastError = "系统 LocationService 不可用";
                Log.e(TAG, "LocationManager is null - system service unavailable");
                return;
            }
        }

        stopInternal();

        updateThread = new HandlerThread("loc-mock-updater");
        updateThread.start();
        updateHandler = new Handler(updateThread.getLooper());
        running = true;

        try {
            for (String providerName : ALL_PROVIDERS) {
                try {
                    // Remove stale test provider first.
                    try {
                        locationManager.removeTestProvider(providerName);
                    } catch (Exception ignored) {
                    }

                    locationManager.addTestProvider(
                            providerName,
                            PROVIDER_NETWORK.equals(providerName), // requiresNetwork
                            !PROVIDER_NETWORK.equals(providerName), // requiresSatellite
                            false,   // requiresCell
                            false,   // hasMonetaryCost
                            false,   // supportsAltitude
                            true,    // supportsSpeed
                            true,    // supportsBearing
                            ProviderProperties.POWER_USAGE_LOW,
                            ProviderProperties.ACCURACY_FINE
                    );
                    locationManager.setTestProviderEnabled(providerName, true);
                    addedProviders.add(providerName);
                    Log.i(TAG, "test provider added: " + providerName);
                } catch (SecurityException se) {
                    // addTestProvider 抛 SecurityException：缺 ACCESS_MOCK_LOCATION 权限，
                    // 或开发者选项未把本应用设为"模拟位置应用"。这是定位不生效的最常见根因。
                    lastError = "缺少模拟定位权限：请在开发者选项中将本应用设为「模拟位置应用」"
                            + "（设置 → 开发者选项 → 选择模拟位置信息应用）。详情：" + se.getMessage();
                    Log.w(TAG, "failed to add test provider " + providerName + ": " + se.getMessage());
                } catch (Exception e) {
                    lastError = "添加 test provider 失败 (" + providerName + ")：" + e.getMessage();
                    Log.w(TAG, "failed to add test provider " + providerName + ": " + e.getMessage());
                }
            }

            if (addedProviders.isEmpty()) {
                if (lastError == null) {
                    lastError = "无法注册任何定位 provider，请在开发者选项中将本应用设为「模拟位置应用」";
                }
                Log.e(TAG, "no test providers could be added");
                stopInternal();
                return;
            }

            pushLocation(); // Push immediately.
            scheduleNextUpdate();
            lastError = null;

            Log.i(TAG, "mock location started: keyword=" + keyword
                    + " lat=" + currentLat + " lng=" + currentLng
                    + " accuracy=" + currentAccuracy
                    + " providers=" + addedProviders);
        } catch (SecurityException se) {
            lastError = "缺少 ACCESS_MOCK_LOCATION 权限或未在开发者选项设为「模拟位置应用」：" + se.getMessage();
            Log.e(TAG, "ACCESS_MOCK_LOCATION permission missing or app not set as mock-location app", se);
            stopInternal();
        } catch (Exception e) {
            lastError = "启动模拟定位失败：" + e.getMessage();
            Log.e(TAG, "failed to start mock location", e);
            stopInternal();
        }
    }

    /**
     * Stop mocking and remove the test providers so real location resumes.
     */
    public synchronized void stopMockLocation() {
        Log.i(TAG, "stopMockLocation called");
        stopInternal();
    }

    // ---- internal ----

    private void stopInternal() {
        running = false;
        if (updateHandler != null) {
            updateHandler.removeCallbacksAndMessages(null);
            updateHandler = null;
        }
        if (updateThread != null) {
            updateThread.quitSafely();
            updateThread = null;
        }
        if (locationManager != null) {
            for (String providerName : addedProviders) {
                try {
                    locationManager.removeTestProvider(providerName);
                    Log.i(TAG, "test provider removed: " + providerName);
                } catch (Exception ignored) {
                }
            }
            addedProviders.clear();
        }
    }

    private void pushLocation() {
        if (locationManager == null) {
            return;
        }

        for (String providerName : addedProviders) {
            Location loc = new Location(providerName);
            loc.setLatitude(currentLat);
            loc.setLongitude(currentLng);
            loc.setAccuracy(currentAccuracy);
            loc.setTime(System.currentTimeMillis());
            loc.setElapsedRealtimeNanos(SystemClock.elapsedRealtimeNanos());
            Bundle extras = new Bundle();
            extras.putInt("satellites", 8);
            loc.setExtras(extras);

            try {
                locationManager.setTestProviderLocation(providerName, loc);
            } catch (Exception e) {
                Log.w(TAG, "pushLocation failed for " + providerName + ": " + e.getMessage());
            }
        }
    }

    private void scheduleNextUpdate() {
        if (!running || updateHandler == null) {
            return;
        }
        updateHandler.postDelayed(() -> {
            pushLocation();
            scheduleNextUpdate();
        }, UPDATE_INTERVAL_MS);
    }

    private static double[] resolveCityCoords(String city) {
        if (city == null) {
            return null;
        }
        // Exact match first.
        for (Map.Entry<String, double[]> entry : CITY_COORDS.entrySet()) {
            if (city.equals(entry.getKey())) {
                return entry.getValue();
            }
        }
        // Contains match.
        for (Map.Entry<String, double[]> entry : CITY_COORDS.entrySet()) {
            if (city.contains(entry.getKey()) || entry.getKey().contains(city)) {
                return entry.getValue();
            }
        }
        return null;
    }

    public boolean isRunning() {
        return running && !addedProviders.isEmpty();
    }

    /**
     * 返回最近一次启动失败的原因，启动成功时为 null。
     * 用于让 NetworkCommandService 把具体失败原因回传前端，避免只看到笼统的"did not start"。
     */
    public String lastError() {
        return lastError;
    }

    public static boolean isValidCoordinate(double lat, double lng) {
        return Double.isFinite(lat)
                && Double.isFinite(lng)
                && lat >= -90.0
                && lat <= 90.0
                && lng >= -180.0
                && lng <= 180.0
                && (lat != 0.0 || lng != 0.0);
    }
}
