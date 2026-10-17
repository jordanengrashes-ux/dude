#!/usr/bin/env python3
"""Self-test for the STEP → GLB pipeline (no VEX files needed).

Builds a Pin-sized two-color assembly in millimeters with Z up (the usual CAD
export), writes it as STEP, converts it with step_to_glb.py and checks that the
GLB is in meters, Y up, 1.6" × 6.5" and keeps the red and yellow part colors.

    python3 scripts/cad/selftest.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from step_to_glb import convert  # noqa: E402


def make_step(path: Path) -> None:
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.STEPControl import STEPControl_AsIs
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_DocumentTool

    r = 0.8 * 25.4
    h = 3.25 * 25.4
    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    colors = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    for z0, rgb in ((0.0, (0.78, 0.13, 0.18)), (h, (0.95, 0.76, 0.0))):
        solid = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, z0 - h), gp_Dir(0, 0, 1)), r, h).Shape()
        label = shapes.AddShape(solid, False)
        colors.SetColor(label, Quantity_Color(*rgb, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
    w = STEPCAFControl_Writer()
    w.SetColorMode(True)
    w.Transfer(doc, STEPControl_AsIs)
    if w.Write(str(path)) != IFSelect_RetDone:
        raise RuntimeError("STEP write failed")


def main() -> int:
    with tempfile.TemporaryDirectory() as d:
        step = Path(d) / "pin-test.step"
        glb = Path(d) / "pin-test.glb"
        make_step(step)
        info = convert(step, glb, 0.1, 0.3, False)
    sx, sy, sz = info["size_m"]
    ok = abs(sx - 0.04064) < 5e-4 and abs(sz - 0.04064) < 5e-4 and abs(sy - 0.1651) < 5e-4
    cols = [m["baseColor"][:3] for m in info["materials"]]
    has_red = any(c[0] > 0.6 and c[1] < 0.3 for c in cols)
    has_yellow = any(c[0] > 0.8 and c[1] > 0.6 and c[2] < 0.2 for c in cols)
    print(f"size (m): {sx:.4f} × {sy:.4f} × {sz:.4f}  (expected 0.0406 × 0.1651 × 0.0406, Y up)")
    print(f"materials: {cols}")
    if ok and has_red and has_yellow:
        print("PASS: meters, Y up, colors kept")
        return 0
    print("FAIL")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
