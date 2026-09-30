#!/usr/bin/env python3
"""
生成原生 tabBar 的图标 PNG（对应 D5 = A 原生 tabBar）

用法：python3 scripts/gen_tab_icons.py

为什么需要这个脚本
------------------
原生 tabBar 的 iconPath **只能是本地图片文件**：不能是 iconfont、不能是 base64
（app.json 的 iconPath 只接受路径）、也不能是网络图。所以要落 8 个 png：
4 个 tab × （未选中 / 选中）两态。

为什么不用无头 Chrome 渲染 SVG
------------------------------
本机 Chrome 常驻运行，无头实例会和它抢 profile，实测卡死在第 2 个图标。
改成纯 Python 光栅化（只用标准库 zlib/struct 手写 PNG 编码器）：
零依赖、几秒跑完、结果完全可复现，也不需要预先装 Pillow / cairosvg。

几何来源
--------
图标 path 直接抄 design/prototype.html 的 tab 图标（viewBox 0 0 20 20），
所以视觉与原型 1:1。改图标只需改下面的 GLYPHS 再重跑。

尺寸 81×81 px（微信官方推荐值，真机按 ~27pt 显示，3 倍屏不糊）
色值：未选中 --text-2 #616770 / 选中 --primary #185fa5（与 app.wxss token 一致）
"""

import os
import struct
import zlib

SIZE = 81          # 输出边长（px）
SS = 4             # 超采样倍数（抗锯齿）
UNIT = 20.0        # 逻辑坐标系边长（对应 svg viewBox）
STROKE = 1.5       # 描边宽度（逻辑单位）
HALF = STROKE / 2

COLOR_OFF = (0x61, 0x67, 0x70)   # --text-2
COLOR_ON = (0x18, 0x5F, 0xA5)    # --primary

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'miniprogram', 'images')


# --------------------------------------------------------------------------
# 几何：全部在 20×20 逻辑坐标里算，输出时再映射到像素
# --------------------------------------------------------------------------

def _d2_seg(px, py, ax, ay, bx, by):
    """点到线段的距离平方"""
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    l2 = vx * vx + vy * vy
    if l2 == 0:
        t = 0.0
    else:
        t = (wx * vx + wy * vy) / l2
        if t < 0.0:
            t = 0.0
        elif t > 1.0:
            t = 1.0
    dx, dy = wx - t * vx, wy - t * vy
    return dx * dx + dy * dy


def polyline(pts, half=HALF):
    """折线描边（圆角连接 / 圆头端点）：到任一线段的距离 <= half 即命中"""
    segs = list(zip(pts, pts[1:]))
    h2 = half * half

    def cov(px, py):
        for (ax, ay), (bx, by) in segs:
            if _d2_seg(px, py, ax, ay, bx, by) <= h2:
                return True
        return False

    return cov


def rrect_sdf(px, py, x, y, w, h, r):
    """圆角矩形**有符号**距离：内部为负、边界为 0、外部为正。

    ⚠️ 不能用「dx=max(...,0) 再开根」那种外侧距离写法——它把内部一律钳成 0，
      于是 `abs(sdf) <= half` 会对**整个内部**成立，描边会被画成实心块（踩过一次）。
    """
    hw, hh = w / 2.0, h / 2.0
    cx, cy = x + hw, y + hh
    r = min(r, hw, hh)
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ax = qx if qx > 0 else 0.0
    ay = qy if qy > 0 else 0.0
    outside = (ax * ax + ay * ay) ** 0.5
    inside = qx if qx > qy else qy
    if inside > 0:
        inside = 0.0
    return outside + inside - r


def disk(px, py, cx, cy, r):
    dx, dy = px - cx, py - cy
    return dx * dx + dy * dy <= r * r


def ring(px, py, cx, cy, r, half=HALF):
    d = ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5
    return abs(d - r) <= half


def cubic(p0, c1, c2, p3, n=18):
    """三次贝塞尔采样成折线"""
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        x = u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0]
        y = u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1]
        out.append((x, y))
    return out


# --------------------------------------------------------------------------
# 4 个图标（与 prototype.html 的 tab 图标同 path）
# --------------------------------------------------------------------------

# 首页：房子轮廓。M3 9.5 L10 4 l7 5.5 V16 a1 1 0 0 1 -1 -1 h-4 v-5 H8 v5 H4 a1 1 0 0 1 -1 -1 z
_HOME = [
    (3, 9.5), (10, 4), (17, 9.5), (17, 16), (16, 17),
    (12, 17), (12, 12), (8, 12), (8, 17), (4, 17), (3, 16), (3, 9.5),
]

# 统计：三根圆角柱（实心）
_STATS_RECTS = [(3, 11, 3, 6), (8.5, 7, 3, 10), (14, 4, 3, 13)]

# 错题本：记事本轮廓 + 两条横线
_WB_LINES = polyline([(8, 7), (12, 7)])
_WB_LINES2 = polyline([(8, 10), (12, 10)])

# 我的：头像（圆 + 肩弧）。肩弧为两段三次贝塞尔拼成的拱形
_PROFILE_ARC = polyline(
    cubic((4, 17), (4, 13.7), (6.7, 11), (10, 11))[:-1]
    + cubic((10, 11), (13.3, 11), (16, 13.7), (16, 17))
)


def glyph_home(px, py):
    return polyline(_HOME)(px, py)


def glyph_stats(px, py):
    for x, y, w, h in _STATS_RECTS:
        if rrect_sdf(px, py, x, y, w, h, 1.0) <= 0:
            return True
    return False


def glyph_wrongbook(px, py):
    if abs(rrect_sdf(px, py, 5, 3, 10, 14, 0.0)) <= HALF:
        return True
    return _WB_LINES(px, py) or _WB_LINES2(px, py)


def glyph_profile(px, py):
    if ring(px, py, 10, 7, 3):
        return True
    return _PROFILE_ARC(px, py)


GLYPHS = {
    'home': glyph_home,
    'stats': glyph_stats,
    'wrongbook': glyph_wrongbook,
    'profile': glyph_profile,
}


# --------------------------------------------------------------------------
# 光栅化 + PNG 编码（只用标准库）
# --------------------------------------------------------------------------

def alpha_mask(glyph):
    """返回 SIZE×SIZE 的 alpha 字节串（0-255），超采样求平均做抗锯齿"""
    fn = GLYPHS[glyph]
    scale = UNIT / (SIZE * SS)          # 子像素步长（逻辑单位）
    rows = []
    for py in range(SIZE):
        row = bytearray()
        for px in range(SIZE):
            hit = 0
            x0 = px * SS
            y0 = py * SS
            for sy in range(SS):
                v = (y0 + sy + 0.5) * scale
                for sx in range(SS):
                    u = (x0 + sx + 0.5) * scale
                    if fn(u, v):
                        hit += 1
            row.append(int(hit * 255 / (SS * SS) + 0.5))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, rgb):
    """RGBA PNG。alpha=0 的像素也写图标色，避免缩放时出现黑边"""
    w = h = SIZE
    r, g, b = rgb
    raw = bytearray()
    for row in rows:
        raw.append(0)                    # filter type 0
        for a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (
            struct.pack('>I', len(data))
            + tag
            + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    total = 0
    for name in GLYPHS:
        mask = alpha_mask(name)          # 两态共用同一份 alpha，只算一次
        for suffix, rgb in (('', COLOR_OFF), ('-on', COLOR_ON)):
            out = os.path.join(OUT_DIR, 'tab-%s%s.png' % (name, suffix))
            write_png(out, mask, rgb)
            size = os.path.getsize(out)
            total += size
            print('  %-24s %6d B' % (os.path.basename(out), size))
    print('共 %d 个图标 → miniprogram/images/，合计 %d B' % (len(GLYPHS) * 2, total))


if __name__ == '__main__':
    main()
