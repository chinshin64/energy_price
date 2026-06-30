"""
mitmproxy addon: Upstream Proxy Auth for CONNECT tunnel

Injects Proxy-Authorization into CONNECT requests to upstream proxy.
"""
import base64
from mitmproxy import ctx, http


class UpstreamProxyAuth:
    def __init__(self):
        self.auth_header = ""

    def load(self, loader):
        loader.add_option(
            name="data_for_didi_upstream_auth_user",
            typespec=str,
            default="",
            help="Upstream proxy username.",
        )
        loader.add_option(
            name="data_for_didi_upstream_auth_pass",
            typespec=str,
            default="",
            help="Upstream proxy password.",
        )

    def running(self):
        user = ctx.options.data_for_didi_upstream_auth_user
        passwd = ctx.options.data_for_didi_upstream_auth_pass
        if user and passwd:
            credentials = base64.b64encode(f"{user}:{passwd}".encode()).decode()
            self.auth_header = f"Basic {credentials}"
            ctx.log.info(f"Upstream proxy auth configured for user: {user}")
        else:
            ctx.log.info("Upstream proxy auth: no credentials configured")

    def httpconnect_upstream(self, f: http.HTTPFlow):
        """Called when mitmproxy sends CONNECT to upstream proxy."""
        if self.auth_header:
            f.request.headers["Proxy-Authorization"] = self.auth_header

    def requestheaders(self, f: http.HTTPFlow):
        """Called for every request before headers are sent."""
        if self.auth_header and f.request.first_line_format == "authority":
            f.request.headers["Proxy-Authorization"] = self.auth_header


addons = [UpstreamProxyAuth()]
