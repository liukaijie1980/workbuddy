# -*- coding: utf-8 -*-
"""
磁吸支架 · 双折叠旋转指环 —— 由产品图反推的 CAD 图纸 (DXF)
含: 正视图 / 俯视图 / 侧视图 / 指环零件图 / 尺寸标注 / 标题栏
单位: mm  比例: 1:1
注: 图片无实物尺寸, 各尺寸按同类磁吸支架常规规格反推, 供参考修正。
"""
import ezdxf
from ezdxf.enums import TextEntityAlignment

# ---------- 参数(反推尺寸) ----------
D_BODY   = 57.0   # 底座外径
R_BODY   = D_BODY / 2
T_BASE   = 5.5    # 磁吸底座总厚
R_DEC1   = 26.0   # 外装饰环外半径
R_DEC2   = 22.5   # 外装饰环内半径(凹槽)
R_MAG    = 19.0   # 磁面外半径
R_CORE   = 15.0   # 中心面板半径
HingeW   = 20.0   # 铰链座宽
HingeH   = 5.0    # 铰链座高
RingW    = 40.0   # 指环外框宽
RingH    = 46.0   # 指环外框高
RingRO   = 14.0   # 指环外框圆角
RingIW   = 27.0   # 指环内孔宽
RingIH   = 33.0   # 指环内孔高
RingRI   = 10.0   # 指环内孔圆角
RingT    = 6.5    # 指环料宽(厚度方向)
T_RING   = 2.0    # 指环板厚

# ---------- 文档初始化 ----------
doc = ezdxf.new("R2010", setup=True)
msp = doc.modelspace()
doc.styles.add("CN", font="simhei.ttf")

layers = {
    "轮廓":   {"color": 7,   "lineweight": 50},
    "细实线": {"color": 8,   "lineweight": 13},
    "中心线": {"color": 1,   "lineweight": 13, "linetype": "CENTER"},
    "虚线":   {"color": 3,   "lineweight": 13, "linetype": "DASHED"},
    "标注":   {"color": 4,   "lineweight": 13},
    "文字":   {"color": 7,   "lineweight": 25},
    "图框":   {"color": 7,   "lineweight": 60},
}
for name, kw in layers.items():
    lt = kw.pop("linetype", None)
    doc.layers.add(name, **kw)
    if lt:
        doc.layers.get(name).dxf.linetype = lt

# ---------- 标注样式 ----------
ds = doc.dimstyles.new("MY", dxfattribs={})
for k, v in dict(dimtxt=2.8, dimasz=2.2, dimexo=0.8, dimexe=1.5, dimgap=0.8,
                 dimdec=1, dimtxsty="CN", dimclrt=4, dimlwd=13, dimlwe=13).items():
    try:
        ds.dxf.set(k, v)
    except Exception:
        pass

def label(x, y, txt, h=4.0, align=TextEntityAlignment.MIDDLE_CENTER, layer="文字"):
    msp.add_text(txt, dxfattribs={"style": "CN", "height": h, "layer": layer,
                                  "color": 7}).set_placement((x, y), align=align)

def centerlines(cx, cy, r):
    g = 4.0
    msp.add_line((cx - r - g, cy), (cx + r + g, cy), dxfattribs={"layer": "中心线"})
    msp.add_line((cx, cy - r - g), (cx, cy + r + g), dxfattribs={"layer": "中心线"})

def rrect(x, y, w, h, r, layer="轮廓", bulge=None):
    """圆角矩形(带凸度弧的 LWPOLYLINE), x,y 为左下角"""
    pts = [
        (x + r, y, 0), (x + w - r, y, 0.5), (x + w, y + r, 0),
        (x + w, y + h - r, 0.5), (x + w - r, y + h, 0),
        (x + r, y + h, 0.5), (x, y + h - r, 0),
        (x, y + r, 0.5), (x + r, y, 0),
    ]
    msp.add_lwpolyline(pts, format="xyb", close=True,
                       dxfattribs={"layer": layer})

# ============================================================
# 1) 正视图  (中心 0,0)   —— 指环收拢贴合于面板
# ============================================================
CX, CY = 0.0, 0.0
centerlines(CX, CY, R_BODY)
for r, lay in [(R_BODY, "轮廓"), (R_DEC1, "轮廓"), (R_DEC2, "细实线"),
               (R_MAG, "轮廓"), (R_CORE, "细实线")]:
    msp.add_circle((CX, CY), r, dxfattribs={"layer": lay})
# 铭牌/装饰刻字环示意(点划圆)
msp.add_circle((CX, CY), (R_DEC1 + R_DEC2) / 2, dxfattribs={"layer": "中心线"})
# 中心 logo 三角示意
import math
tri = [(CX, CY + 6), (CX - 5.2, CY - 3), (CX + 5.2, CY - 3)]
msp.add_lwpolyline(tri, close=True, dxfattribs={"layer": "细实线"})

# 底部铰链座
hy = -R_BODY - 0.0
msp.add_lwpolyline([(CX - HingeW/2, CY - R_BODY + 2),
                    (CX - HingeW/2, CY - R_BODY - HingeH),
                    (CX + HingeW/2, CY - R_BODY - HingeH),
                    (CX + HingeW/2, CY - R_BODY + 2)],
                   dxfattribs={"layer": "轮廓"})
msp.add_circle((CX - 6.5, CY - R_BODY - 2.5), 1.2, dxfattribs={"layer": "轮廓"})
msp.add_circle((CX + 6.5, CY - R_BODY - 2.5), 1.2, dxfattribs={"layer": "轮廓"})

# 收拢状态的指环(压在面板上, 圆角方形环示意)
row, col = CY - 2.0, CX
rrect(row - RingW/2, col - RingH/2, RingW, RingH, RingRO, layer="虚线")
rrect(row - RingIW/2, col - RingIH/2, RingIW, RingIH, RingRI, layer="虚线")

# 正视图标注
d = msp.add_radius_dim((CX, CY), radius=R_BODY, angle=-45, dimstyle="MY",
                       override={"dimexe": 1.5}); d.render()
d = msp.add_linear_dim(base=(0, 34), p1=(CX - RingW/2, col - RingH/2),
                       p2=(CX + RingW/2, col - RingH/2), dimstyle="MY"); d.render()
d = msp.add_linear_dim(base=(CX + 34, 0), p1=(CX + 26, col - RingH/2),
                       p2=(CX + 26, col + RingH/2), angle=90, dimstyle="MY"); d.render()
label(CX, CY + 44, "正视图 (指环收拢)", 4.5)

# ============================================================
# 2) 俯视图  (中心 150, 0)
# ============================================================
TX, TY = 150.0, 0.0
msp.add_circle((TX, TY), R_BODY, dxfattribs={"layer": "轮廓"})
msp.add_circle((TX, TY), R_BODY - 2.5, dxfattribs={"layer": "细实线"})  # 壁厚
centerlines(TX, TY, R_BODY)
# 顶部铰链缝
msp.add_line((TX - HingeW/2, TY + R_BODY), (TX - HingeW/2, TY + R_BODY - 4),
             dxfattribs={"layer": "轮廓"})
msp.add_line((TX + HingeW/2, TY + R_BODY), (TX + HingeW/2, TY + R_BODY - 4),
             dxfattribs={"layer": "轮廓"})
msp.add_line((TX - HingeW/2, TY + R_BODY - 4), (TX + HingeW/2, TY + R_BODY - 4),
             dxfattribs={"layer": "轮廓"})

d = msp.add_radius_dim((TX, TY), radius=R_BODY, angle=135, dimstyle="MY"); d.render()
label(TX, TY + 44, "俯视图", 4.5)

# ============================================================
# 3) 侧视图(左视)  中心 (270, 0)  —— 展开剖面示意
# ============================================================
SX = 260.0
# 底座
msp.add_lwpolyline([(SX - R_BODY, -T_BASE), (SX - R_BODY, 0), (SX + R_BODY, 0),
                    (SX + R_BODY, -T_BASE), (SX - R_BODY, -T_BASE)],
                   dxfattribs={"layer": "轮廓"})
msp.add_line((SX - R_BODY, 0), (SX + R_BODY, 0), dxfattribs={"layer": "轮廓"})
# 磁面凸台
msp.add_lwpolyline([(SX - R_MAG, 0), (SX - R_MAG, T_BASE - 3.5),
                    (SX + R_MAG, T_BASE - 3.5), (SX + R_MAG, 0)],
                   dxfattribs={"layer": "轮廓"})
# 铰链(底部中间)
msp.add_lwpolyline([(SX - HingeW/2, -T_BASE), (SX - HingeW/2, -T_BASE - 2.5),
                    (SX + HingeW/2, -T_BASE - 2.5), (SX + HingeW/2, -T_BASE)],
                   dxfattribs={"layer": "轮廓"})
# 展开指环侧视: 从铰链向上翻开的板(示意)
msp.add_lwpolyline([(SX - HingeW/2, -T_BASE - 2.5), (SX - HingeW/2, 26),
                    (SX + HingeW/2, 26), (SX + HingeW/2, -T_BASE - 2.5)],
                   dxfattribs={"layer": "虚线"})
msp.add_line((SX - HingeW/2, 26), (SX + HingeW/2, 26), dxfattribs={"layer": "虚线"})
centerlines(SX, -T_BASE / 2, R_BODY)

d = msp.add_linear_dim(base=(SX, 10), p1=(SX - R_BODY, 0), p2=(SX + R_BODY, 0),
                       dimstyle="MY"); d.render()
d = msp.add_linear_dim(base=(SX + R_BODY + 12, 0), p1=(SX + R_BODY, 0),
                       p2=(SX + R_BODY, -T_BASE), angle=90, dimstyle="MY"); d.render()
label(SX, 36, "侧视图 (指环展开)", 4.5)

# ============================================================
# 4) 指环零件图  (原点 0, -110)
# ============================================================
GX, GY = 0.0, -115.0
rrect(GX - RingW/2, GY - RingH/2, RingW, RingH, RingRO)
rrect(GX - RingIW/2, GY - RingIH/2, RingIW, RingIH, RingRI)
centerlines(GX, GY, 26)
# 铰链安装孔
msp.add_circle((GX - 7, GY - RingH/2 + 5), 1.5, dxfattribs={"layer": "轮廓"})
msp.add_circle((GX + 7, GY - RingH/2 + 5), 1.5, dxfattribs={"layer": "轮廓"})
# 料宽标注
d = msp.add_linear_dim(base=(0, GY - RingH/2 - 14), p1=(GX - RingW/2, GY - RingH/2),
                       p2=(GX + RingW/2, GY - RingH/2), dimstyle="MY"); d.render()
d = msp.add_linear_dim(base=(GX + RingW/2 + 12, GY), p1=(GX + RingW/2, GY - RingH/2),
                       p2=(GX + RingW/2, GY + RingH/2), angle=90, dimstyle="MY"); d.render()
d = msp.add_radius_dim((GX, GY), radius=RingRO, angle=45, dimstyle="MY",
                       location=(GX + 26, GY + 22)); d.render()
label(GX, GY + RingH/2 + 8, "指环零件图 (板厚 %.1f)" % T_RING, 4.5)

# ============================================================
# 5) 图框 + 标题栏
# ============================================================
msp.add_lwpolyline([(-75, -160), (-75, 65), (345, 65), (345, -160)],
                   close=True, dxfattribs={"layer": "图框"})
tb_x, tb_y = 195, -160
msp.add_lwpolyline([(tb_x, tb_y), (tb_x, tb_y + 38), (345, tb_y + 38)],
                   dxfattribs={"layer": "图框"})
for yy in (tb_y + 12, tb_y + 25):
    msp.add_line((tb_x, yy), (345, yy), dxfattribs={"layer": "细实线"})
msp.add_line((tb_x + 55, tb_y + 12), (tb_x + 55, tb_y + 38), dxfattribs={"layer": "细实线"})
msp.add_line((tb_x + 100, tb_y + 12), (tb_x + 100, tb_y + 38), dxfattribs={"layer": "细实线"})

label(tb_x + 27, tb_y + 32, "磁吸支架·双折叠旋转指环", 3.4)
label(tb_x + 27, tb_y + 18, "产品结构图 (反推)", 3.0)
label(tb_x + 77, tb_y + 32, "比例 1:1", 3.0)
label(tb_x + 77, tb_y + 18, "单位 mm", 3.0)
label(tb_x + 122, tb_y + 32, "图号: MRS-001", 3.0)
label(tb_x + 122, tb_y + 18, "版本: A/0", 3.0)

notes = [
    "技术要求:",
    "1. 尺寸由产品图反推, 无实物核对, 仅供结构参考;",
    "2. 未注公差按 GB/T 1804-m;",
    "3. 底座: 锌合金+磁铁组件, 指环: 不锈钢/铝合金;",
    "4. 指环可 360° 旋转、双折叠收拢贴合面板;",
    "5. 表面阳极氧化处理;",
]
for i, t in enumerate(notes):
    label(95, -95 - i * 7, t, 3.0, align=TextEntityAlignment.LEFT)

out = r"C:\Users\20786\WorkBuddy\2026-09-28-21-36-21\outputs\磁吸支架指环_CAD图纸.dxf"
doc.saveas(out)
print("saved:", out)
