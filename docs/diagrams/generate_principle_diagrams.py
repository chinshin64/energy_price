from pathlib import Path
from math import atan2, cos, sin, pi

from PIL import Image, ImageDraw, ImageFilter, ImageFont


OUT_DIR = Path(__file__).resolve().parent
FONT_REGULAR = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FONT_BOLD = "/System/Library/Fonts/STHeiti Medium.ttc"


def font(size, bold=False):
    path = FONT_BOLD if bold else FONT_REGULAR
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def text_bbox(draw, text, fnt):
    return draw.textbbox((0, 0), text, font=fnt)


def text_width(draw, text, fnt):
    box = text_bbox(draw, text, fnt)
    return box[2] - box[0]


def wrap_text(draw, text, fnt, max_width):
    lines = []
    for paragraph in str(text).split("\n"):
        current = ""
        for char in paragraph:
            candidate = current + char
            if current and text_width(draw, candidate, fnt) > max_width:
                lines.append(current.rstrip())
                current = char.lstrip()
            else:
                current = candidate
        if current:
            lines.append(current.rstrip())
    return lines or [""]


def draw_wrapped(draw, xy, text, fnt, fill, max_width, line_gap=8):
    x, y = xy
    lines = wrap_text(draw, text, fnt, max_width)
    line_height = text_bbox(draw, "国Ag", fnt)[3] - text_bbox(draw, "国Ag", fnt)[1]
    for line in lines:
        draw.text((x, y), line, font=fnt, fill=fill)
        y += line_height + line_gap
    return y


def rounded_shadow(base, box, radius=28, shadow=(18, 32, 56, 28), blur=22, offset=(0, 10)):
    x1, y1, x2, y2 = box
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    sx, sy = offset
    ld.rounded_rectangle((x1 + sx, y1 + sy, x2 + sx, y2 + sy), radius=radius, fill=shadow)
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    base.alpha_composite(layer)


def card(draw, base, box, accent, tag, title, body, border=None, fill=(255, 255, 255, 248)):
    x1, y1, x2, y2 = box
    border = border or accent
    rounded_shadow(base, box, radius=26)
    draw.rounded_rectangle(box, radius=26, fill=fill, outline=border, width=2)

    tag_font = font(18)
    title_font = font(26, bold=True)
    body_font = font(19)
    tag_w = max(74, text_width(draw, tag, tag_font) + 34)
    draw.rounded_rectangle((x1 + 24, y1 + 24, x1 + 24 + tag_w, y1 + 62), radius=19, fill=accent)
    draw.text((x1 + 24 + (tag_w - text_width(draw, tag, tag_font)) / 2, y1 + 31), tag, font=tag_font, fill="white")
    draw.text((x1 + 24 + tag_w + 22, y1 + 23), title, font=title_font, fill=(24, 35, 62))
    draw_wrapped(draw, (x1 + 26, y1 + 76), body, body_font, (99, 112, 137), x2 - x1 - 52, line_gap=6)


def center_card(draw, base, box, accent, title, lines):
    x1, y1, x2, y2 = box
    rounded_shadow(base, box, radius=34, shadow=(18, 32, 56, 22), blur=24, offset=(0, 12))
    draw.rounded_rectangle(box, radius=34, fill=(255, 255, 255, 250), outline=accent, width=3)
    title_font = font(42, bold=True)
    body_font = font(22)
    draw.text((x1 + (x2 - x1 - text_width(draw, title, title_font)) / 2, y1 + 54), title, font=title_font, fill=(23, 34, 60))
    y = y1 + 122
    for label, value in lines:
        label_font = font(22, bold=True)
        label_text = f"{label}："
        label_w = text_width(draw, label_text, label_font)
        draw.text((x1 + 54, y), label_text, font=label_font, fill=accent)
        y = draw_wrapped(draw, (x1 + 54 + label_w, y), value, body_font, (93, 105, 130), x2 - x1 - 96 - label_w, line_gap=5)
        y += 6


def arrow(draw, start, end, color, width=5):
    x1, y1 = start
    x2, y2 = end
    draw.line((x1, y1, x2, y2), fill=color, width=width)
    angle = atan2(y2 - y1, x2 - x1)
    size = 16
    p1 = (x2, y2)
    p2 = (x2 - size * cos(angle - pi / 7), y2 - size * sin(angle - pi / 7))
    p3 = (x2 - size * cos(angle + pi / 7), y2 - size * sin(angle + pi / 7))
    draw.polygon([p1, p2, p3], fill=color)


def gradient(size, left, right):
    width, height = size
    img = Image.new("RGBA", size, left)
    px = img.load()
    for x in range(width):
        ratio = x / max(1, width - 1)
        col = tuple(int(left[i] * (1 - ratio) + right[i] * ratio) for i in range(4))
        for y in range(height):
            px[x, y] = col
    return img


def draw_method(spec, path):
    w, h = 1800, 1280
    base = gradient((w, h), spec["bg_left"], spec["bg_right"])
    draw = ImageDraw.Draw(base)

    # Header.
    rounded_shadow(base, (58, 44, 1742, 164), radius=32, blur=24, offset=(0, 12))
    draw.rounded_rectangle((58, 44, 1742, 164), radius=32, fill=(255, 255, 255, 246))
    badge = (92, 70, 164, 136)
    draw.rounded_rectangle(badge, radius=22, fill=spec["accent"])
    draw.text((111, 93), spec["badge"], font=font(17, bold=True), fill="white")
    draw.text((194, 70), spec["title"], font=font(47, bold=True), fill=(21, 31, 57))
    draw.text((196, 123), spec["subtitle"], font=font(24), fill=(99, 112, 137))

    # Section labels.
    label_font = font(27, bold=True)
    for text, x, y, color in spec["labels"]:
        draw.rounded_rectangle((x, y, x + text_width(draw, text, label_font) + 34, y + 44), radius=18, fill=(255, 255, 255, 220), outline=(226, 232, 243))
        draw.rounded_rectangle((x, y + 10, x + 8, y + 38), radius=4, fill=color)
        draw.text((x + 22, y + 7), text, font=label_font, fill=(24, 35, 62))

    left_boxes = [(100, 320, 530, 510), (100, 548, 530, 738), (100, 776, 530, 966)]
    right_boxes = [(1280, 320, 1700, 510), (1280, 548, 1700, 738), (1280, 776, 1700, 966)]
    center_box = (625, 408, 1175, 830)

    for box, item in zip(left_boxes, spec["left"]):
        card(draw, base, box, spec["left_color"], item["tag"], item["title"], item["body"])
    for box, item in zip(right_boxes, spec["right"]):
        card(draw, base, box, spec["right_color"], item["tag"], item["title"], item["body"])
    center_card(draw, base, center_box, spec["center_color"], spec["center_title"], spec["center_lines"])

    # Arrows.
    for y in [415, 643, 871]:
        arrow(draw, (530, y), (625, 620 + (y - 643) * 0.45), spec["left_color"], width=4)
    for y in [415, 643, 871]:
        arrow(draw, (1175, 620 + (y - 643) * 0.45), (1280, y), spec["right_color"], width=4)

    # Feedback arc.
    arc_color = (143, 154, 176)
    draw.arc((520, 865, 1300, 1095), 24, 157, fill=arc_color, width=3)
    arrow(draw, (540, 917), (515, 900), arc_color, width=3)
    note_font = font(18)
    draw.text((690, 1015), spec["feedback"], font=note_font, fill=(112, 125, 150))

    # Takeaway.
    draw.rounded_rectangle((250, 1192, 1550, 1250), radius=29, fill=(21, 31, 57))
    takeaway_font = font(27, bold=True)
    takeaway = spec["takeaway"]
    draw.text((250 + (1300 - text_width(draw, takeaway, takeaway_font)) / 2, 1206), takeaway, font=takeaway_font, fill=(255, 255, 255))

    base.convert("RGB").save(path, quality=96)


METHODS = [
    {
        "badge": "页面自动化识别",
        "title": "页面自动化识别技术原理图",
        "subtitle": "自动下滑后读取页面可见内容，优先页面文本，OCR 兜底，并用详情页补全缺失字段。",
        "accent": (255, 110, 24),
        "left_color": (255, 116, 24),
        "right_color": (85, 70, 235),
        "center_color": (255, 168, 82),
        "bg_left": (255, 247, 238, 255),
        "bg_right": (244, 248, 255, 255),
        "labels": [("页面与设备侧", 92, 216, (255, 116, 24)), ("后端与质量侧", 1190, 216, (85, 70, 235))],
        "left": [
            {"tag": "数据源", "title": "微信小程序渲染层", "body": "页面已经展示场站名、地址、价格、枪数；不要求接口明文。"},
            {"tag": "控制源", "title": "Android 控制能力", "body": "ADB 广播、辅助功能、悬浮窗、自定义输入法，负责点击、输入、下滑和返回。"},
            {"tag": "采样", "title": "地标采样策略", "body": "单地标约 90-100 个有效场站；同城多中心地标覆盖。"},
        ],
        "center_title": "手机采集器",
        "center_lines": [
            ("控制面", "点击 / 输入 / 随机下滑 / 返回"),
            ("识别面", "可访问性文本优先，截图 OCR 兜底"),
            ("解析面", "卡片重建、字段抽取、噪声过滤、详情补全"),
        ],
        "right": [
            {"tag": "解析", "title": "字段结构化", "body": "按坐标 band 绑定标题附近价格、快慢超枪数和地址候选。"},
            {"tag": "审计", "title": "质量门禁", "body": "过滤 UI 文案、优惠券、营销页、无效价格、跨城 token。"},
            {"tag": "入库", "title": "统一入库模型", "body": "写入手机同步接口，与其他链路统一去重、展示和导出。"},
        ],
        "feedback": "审计失败或字段缺失 -> 换地标 / 补规则 / 进入详情页补全",
        "takeaway": "关键取舍：不依赖接口明文，准确性依赖页面识别和质量审计",
    },
    {
        "badge": "后台自动化识别",
        "title": "后台自动化识别技术原理图",
        "subtitle": "自动化流程负责触发真实请求，内置录包服务保留接口响应，再由后端解析、学习和入库。",
        "accent": (18, 181, 123),
        "left_color": (255, 116, 24),
        "right_color": (18, 181, 123),
        "center_color": (110, 222, 165),
        "bg_left": (248, 251, 255, 255),
        "bg_right": (238, 255, 247, 255),
        "labels": [("请求触发侧", 92, 216, (255, 116, 24)), ("解析学习侧", 1190, 216, (18, 181, 123))],
        "left": [
            {"tag": "App", "title": "小程序真实运行", "body": "微信小程序按正常业务逻辑发起列表、详情和价格接口。"},
            {"tag": "触发", "title": "自动化浏览", "body": "自动切城市/地标、点击列表、下滑，制造足够接口样本。"},
            {"tag": "边界", "title": "系统录包", "body": "后端自动启动和停止录包会话，HAR 由系统生成并归档。"},
        ],
        "center_title": "代理抓包层",
        "center_lines": [
            ("记录", "URL / Header / Body / Response"),
            ("导入", "系统 HAR 文件"),
            ("判断", "明文 JSON / 加密 / 证书校验失败"),
        ],
        "right": [
            {"tag": "解析", "title": "HAR 解析器", "body": "从请求响应中定位场站数组、价格字段、枪口字段和地址。"},
            {"tag": "学习", "title": "模板学习器", "body": "抽象 URL、参数、Header、分页字段和响应路径模板。"},
            {"tag": "入库", "title": "统一入库", "body": "解析成功的数据写入场站表和分时价格模型。"},
        ],
        "feedback": "稳定接口模板可沉淀到流量自动化识别；加密或证书失败则回退页面自动化识别",
        "takeaway": "关键取舍：字段准确性高，但受 HTTPS 证书、加密参数和导出流程影响",
    },
    {
        "badge": "流量自动化识别",
        "title": "流量自动化识别技术原理图",
        "subtitle": "后端直接使用已学习模板请求目标城市/地标接口，并统一解析、去重、统计进度。",
        "accent": (92, 92, 236),
        "left_color": (92, 92, 236),
        "right_color": (255, 116, 24),
        "center_color": (162, 174, 255),
        "bg_left": (242, 245, 255, 255),
        "bg_right": (255, 249, 241, 255),
        "labels": [("输入与配置", 92, 216, (92, 92, 236)), ("结果与反馈", 1190, 216, (255, 116, 24))],
        "left": [
            {"tag": "位置", "title": "目标位置上下文", "body": "关键词、名称、省市区、经纬度；支持城市、街道、地标和场站。"},
            {"tag": "模板", "title": "API 模板库", "body": "来源于 HAR 学习或人工维护，包含请求结构和字段映射。"},
            {"tag": "代理", "title": "代理池配置", "body": "手动代理池 + 代理商 API 补充，只作用于场站查询请求。"},
        ],
        "center_title": "模板执行引擎",
        "center_lines": [
            ("参数", "城市 / 地标 / 经纬度 / 分页"),
            ("请求", "当次上限、并发任务、成功与 501 统计"),
            ("代理", "城市代理 > 省级代理 > 默认代理 > 直连"),
            ("解析", "列表模板 + 详情模板 + 分时价格结构化"),
        ],
        "right": [
            {"tag": "字段", "title": "标准化响应解析", "body": "抽取名称、地址、快慢超数量、价格和分时价。"},
            {"tag": "进度", "title": "任务进度模型", "body": "展示请求数、成功数、501 数、剩余数和错误原因。"},
            {"tag": "展示", "title": "统一展示与导出", "body": "多平台去重后进入主端数据中心；团油按油号展示。"},
        ],
        "feedback": "失败反馈 -> 换代理 / 调整模板 / 降级到后台自动化识别或页面自动化识别",
        "takeaway": "关键取舍：效率最高，依赖模板稳定性、参数有效性和城市代理策略",
    },
]


def build_combined(paths, out_path):
    images = [Image.open(path).convert("RGB") for path in paths]
    width = 1800
    header_h = 210
    gap = 28
    height = header_h + sum(img.height for img in images) + gap * (len(images) + 1)
    base = gradient((width, height), (255, 249, 242, 255), (243, 247, 255, 255)).convert("RGBA")
    draw = ImageDraw.Draw(base)
    draw.text((70, 58), "三种数据学习方式技术原理总览", font=font(54, bold=True), fill=(21, 31, 57))
    draw.text((72, 125), "页面自动化识别读取前端页面，后台自动化识别使用内置录包/HAR，流量自动化识别执行模板 API；最终统一字段、去重、展示和导出。", font=font(25), fill=(99, 112, 137))
    y = header_h + gap
    for img in images:
        base.paste(img, (0, y))
        y += img.height + gap
    base.convert("RGB").save(out_path, quality=96)


def main():
    outputs = []
    for index, spec in enumerate(METHODS, start=1):
        path = OUT_DIR / f"method-{index}-principle.png"
        draw_method(spec, path)
        outputs.append(path)
    build_combined(outputs, OUT_DIR / "methods-principle-combined.png")


if __name__ == "__main__":
    main()
