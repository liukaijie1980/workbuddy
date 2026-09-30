# -*- coding: utf-8 -*-
import ezdxf
from ezdxf.addons.drawing import RenderContext, Frontend
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
import matplotlib.pyplot as plt

doc = ezdxf.readfile(r"C:\Users\20786\WorkBuddy\2026-09-28-21-36-21\outputs\磁吸支架指环_CAD图纸.dxf")
fig = plt.figure(figsize=(16, 9), facecolor="white")
ax = fig.add_axes([0, 0, 1, 1], facecolor="white")
ctx = RenderContext(doc)
backend = MatplotlibBackend(ax)
Frontend(ctx, backend).draw_layout(doc.modelspace(), finalize=True)
fig.savefig(r"C:\Users\20786\WorkBuddy\2026-09-28-21-36-21\outputs\磁吸支架指环_CAD预览.png",
            dpi=160, facecolor="white")
print("preview saved")
