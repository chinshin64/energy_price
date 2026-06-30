"""
mitmproxy addon: Location Override

Intercepts WeChat mini program requests and replaces lat/lng coordinates
with a target city's coordinates.

Usage:
    mitmdump -s mitm-location-override.py \
        --set data_for_didi_override_city=上海 \
        --set data_for_didi_override_lat=31.2304 \
        --set data_for_didi_override_lng=121.4737
"""

import json
from mitmproxy import ctx, http


CITY_COORDINATES = {
    "上海": (31.2304, 121.4737),
    "北京": (39.9042, 116.4074),
    "杭州": (30.2741, 120.1551),
    "广州": (23.1291, 113.2644),
    "深圳": (22.5431, 114.0579),
    "武汉": (30.5928, 114.3055),
    "南京": (32.0603, 118.7969),
    "成都": (30.5728, 104.0668),
    "西安": (34.3416, 108.9398),
    "重庆": (29.4316, 106.9123),
    "天津": (39.3434, 117.3616),
    "苏州": (31.2990, 120.5853),
    "长沙": (28.2282, 112.9388),
    "郑州": (34.7466, 113.6254),
    "青岛": (36.0671, 120.3826),
}

LOCATION_API_PATHS = [
    "/station-api/homepage/stationlist",
    "/station-api/homepage/stationList",
    "/station-api/station/getoneinfo",
    "/station-api/homePageLayout",
    "/phantom/queryUserElectricityUnit",
]


class LocationOverride:
    def __init__(self):
        self.override_city = ""
        self.override_lat = None
        self.override_lng = None
        self.override_count = 0
        self.skip_count = 0

    def load(self, loader):
        loader.add_option(
            name="data_for_didi_override_city",
            typespec=str,
            default="",
            help="Target city name for location override.",
        )
        loader.add_option(
            name="data_for_didi_override_lat",
            typespec=str,
            default="",
            help="Override latitude (empty = use city lookup).",
        )
        loader.add_option(
            name="data_for_didi_override_lng",
            typespec=str,
            default="",
            help="Override longitude (empty = use city lookup).",
        )

    def running(self):
        city = ctx.options.data_for_didi_override_city
        lat_str = ctx.options.data_for_didi_override_lat
        lng_str = ctx.options.data_for_didi_override_lng

        if city:
            self.override_city = city
            if lat_str and lng_str:
                try:
                    self.override_lat = float(lat_str)
                    self.override_lng = float(lng_str)
                except ValueError:
                    pass
            if not self.override_lat and city in CITY_COORDINATES:
                self.override_lat, self.override_lng = CITY_COORDINATES[city]
            if not self.override_lat:
                ctx.log.warn(f"Location override: city '{city}' not in preset list and no valid lat/lng provided")

        if self.override_lat and self.override_lng:
            ctx.log.info(f"Location override ACTIVE: city={self.override_city} lat={self.override_lat} lng={self.override_lng}")
        else:
            ctx.log.info("Location override INACTIVE: no city/coordinates configured")

    def request(self, flow: http.HTTPFlow):
        if not self.override_lat or not self.override_lng:
            return

        path = flow.request.path.split("?")[0].lower()
        is_target = any(p.lower() in path for p in LOCATION_API_PATHS)
        if not is_target:
            self.skip_count += 1
            return

        modified = False

        # Override in query parameters
        for key in ["lat", "userlat", "latitude"]:
            if key in flow.request.query:
                flow.request.query[key] = str(self.override_lat)
                modified = True
        for key in ["lng", "userlng", "longitude", "lon"]:
            if key in flow.request.query:
                flow.request.query[key] = str(self.override_lng)
                modified = True

        # Override in JSON body
        content_type = flow.request.headers.get("content-type", "")
        if "json" in content_type and flow.request.content:
            try:
                body = json.loads(flow.request.content)
                for key in ["lat", "userlat"]:
                    if key in body:
                        body[key] = self.override_lat
                        modified = True
                for key in ["lng", "userlng", "lon"]:
                    if key in body:
                        body[key] = self.override_lng
                        modified = True
                if modified:
                    flow.request.content = json.dumps(body, ensure_ascii=False).encode("utf-8")
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass

        if modified:
            self.override_count += 1
            ctx.log.info(f"Location override applied: {flow.request.pretty_host}{flow.request.path} -> {self.override_city}({self.override_lat},{self.override_lng}) [{self.override_count} total]")


addons = [LocationOverride()]
