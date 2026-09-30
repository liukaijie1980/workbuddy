---
name: image-to-cad-dxf
description: 将产品平面图/渲染图/示意图转化为 CAD 图纸（DXF 格式）。当用户要求"把图片转成 CAD"、"图转 DXF"、"平面图转工程图"、"生成 CAD 图纸"时使用。用 Python + ezdxf 生成含多视图、尺寸标注、标题栏的 DXF，并渲染 PNG 预览。
---

# 图片转 CAD 图纸 (DXF)

把产品图/平面图/示意图转化为可编辑的 CAD 图纸。核心工具链：**Python + ezdxf**（生成 DXF）+ **matplotlib**（渲染 PNG 预览）。

## 环境准备

```bash
# 用户级安装（本机已验证可行的路径）
python -m pip install --user ezdxf matplotlib
# 其中 python = C:/Users/20786/.workbuddy/binaries/python/versions/3.13.12/python.exe
```

## 工作流程

1. **读图分析产品结构**（Read 工具直接看图）：
   - 识别产品类型（圆形件/板类件/壳体等）、组成部分（主体、装饰件、铰链、孔位等）
   - 判断需要哪些视图：通常 正视图 + 俯视图 + 侧视图 + 关键零件图
2. **反推尺寸**：图上没有真实尺寸时，按同类产品常规规格反推，并在图纸技术要求中注明"尺寸由产品图反推，仅供结构参考"。常见反推依据：手机磁吸支架 Ø57×5.5、指环外框 40×46 R14 等。
3. **写 Python 脚本生成 DXF**：参考本技能目录下的 `assets/gen_template.py`（完整可运行示例，含下述所有要点的用法）。
4. **渲染 PNG 预览**：用 `assets/render_preview.py`，必须亲眼 Read 检查：文字是否方框、视图是否重叠、标注是否错位。
5. **迭代修正**后用 present_files 同时交付 DXF + PNG。

## 图纸必备要素

- 图层：轮廓（粗）、细实线、中心线（CENTER 线型、红色）、虚线（DASHED、绿色）、标注、文字、图框
- 视图布置：留足间距，零件图/技术要求/标题栏不要与视图重叠（本次踩过：技术要求文字与零件图重叠）
- 标题栏：产品名、比例 1:1、单位 mm、图号、版本
- 技术要求 4~5 条：尺寸来源声明、未注公差 GB/T 1804-m、材质建议、表面处理
- 标注：linear_dim（长度）、radius_dim（半径）；中心线超出轮廓 4mm

## 关键陷阱（实测踩坑）

1. **中文字体**：DXF 文字样式必须写**实际字体文件名** `doc.styles.add("CN", font="simhei.ttf")`。写 `"SimSun"`/`"SimHei"` 家族名时 ezdxf 渲染预览会显示方框（□□□）。AutoCAD 打开时 simhei.ttf 也能正常解析。
2. **radius_dim 签名**：`msp.add_radius_dim(center, radius=r, angle=a)` —— 第二个位置参数是 mpoint 不是 radius，必须用关键字 `radius=` 传，否则报 `TypeError: object of type 'float' has no len()`。
3. **linear_dim 基点**：垂直标注（angle=90）的 base 点不要与 p1/p2 的 y 值相同，用 `base=(x偏移, 0)` 否则渲染异常。
4. **封闭轮廓**：lwpolyline 画矩形类轮廓要闭合（close=True 或末点回到起点），侧视图底座漏底边在缩略预览里很难发现，放大裁剪检查。
5. **圆角矩形**：用带凸度(bulge)的 lwpolyline，见模板 `rrect()` 函数。
6. **预览验证**：渲染后务必 Read 查看 PNG；有疑点用 PIL 裁剪放大局部检查，检查完删除临时裁剪文件。

## 交付标准

- DXF 保存为 R2010 格式（兼容性最好）
- 文件名用中文描述性名称，如 `磁吸支架指环_CAD图纸.dxf`
- present_files 一次传入 DXF + PNG 两个文件
- 回复中说明：尺寸为反推值，邀请用户提供实测尺寸后更新
