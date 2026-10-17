#!/usr/bin/env python3
"""Convert official VEX STEP files to GLB for the 3D view.

Usage:
    pip install cadquery-ocp            # OpenCASCADE bindings (one time)
    python3 scripts/cad/step_to_glb.py input.step public/models/goal-neutral.glb
    python3 scripts/cad/step_to_glb.py cad/ public/models/      # every .step/.stp in a folder

Options:
    --deflection MM   linear tessellation tolerance in millimeters (default 0.15)
    --angular RAD     angular tessellation tolerance (default 0.35)
    --y-up            the STEP is already Y-up (default assumes CAD Z-up)

Part colors and names from the STEP (XCAF) are kept as glTF materials and
nodes. Lengths come out in meters and Y is up, matching the app's world frame.
Each output's bounding box is printed so its alignment with the element frames
in docs/CAD.md can be checked; fix-up transforms go in public/models/manifest.json.
"""
from __future__ import annotations

import argparse
import struct
import json
import sys
from pathlib import Path


def convert(src: Path, dst: Path, deflection: float, angular: float, y_up: bool) -> dict:
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Message import Message_ProgressRange
    from OCP.RWGltf import RWGltf_CafWriter
    from OCP.RWMesh import RWMesh_CoordinateSystem
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
    from OCP.OCP.collections import IndexedDataMap_TCollection_AsciiString_TCollection_AsciiString as FileInfo
    from OCP.OCP.collections import Sequence_TDF_Label as TDF_LabelSequence
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    reader.SetNameMode(True)
    reader.SetLayerMode(True)
    if reader.ReadFile(str(src)) != IFSelect_RetDone:
        raise RuntimeError(f"could not read {src}")
    if not reader.Transfer(doc):
        raise RuntimeError(f"could not transfer {src}")

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    labels = TDF_LabelSequence()
    shape_tool.GetFreeShapes(labels)
    for i in range(1, labels.Length() + 1):
        shape = shape_tool.GetShape_s(labels.Value(i))
        BRepMesh_IncrementalMesh(shape, deflection, False, angular, True)

    dst.parent.mkdir(parents=True, exist_ok=True)
    writer = RWGltf_CafWriter(TCollection_AsciiString(str(dst)), True)
    conv = writer.ChangeCoordinateSystemConverter()
    conv.SetInputLengthUnit(0.001)  # OpenCASCADE works in millimeters
    conv.SetInputCoordinateSystem(RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_glTF if y_up else RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Zup)
    if not writer.Perform(doc, FileInfo(), Message_ProgressRange()):
        raise RuntimeError(f"could not write {dst}")
    return glb_summary(dst)


def glb_summary(path: Path) -> dict:
    """Bounding box (meters) and material colors read back from the GLB."""
    data = path.read_bytes()
    magic, _version, _length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise RuntimeError("not a GLB")
    chunk_len, _chunk_type = struct.unpack_from("<II", data, 12)
    gltf = json.loads(data[20 : 20 + chunk_len])
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    # node transforms are not applied here; the converter writes vertices in model space
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            acc = gltf["accessors"][prim["attributes"]["POSITION"]]
            if "min" in acc:
                lo = [min(a, b) for a, b in zip(lo, acc["min"])]
                hi = [max(a, b) for a, b in zip(hi, acc["max"])]
    colors = []
    for m in gltf.get("materials", []):
        pbr = m.get("pbrMetallicRoughness", {})
        colors.append({"name": m.get("name"), "baseColor": [round(c, 3) for c in pbr.get("baseColorFactor", [1, 1, 1, 1])]})
    return {"file": str(path), "bbox_min_m": lo, "bbox_max_m": hi, "size_m": [h - l for l, h in zip(lo, hi)], "materials": colors, "meshes": len(gltf.get("meshes", []))}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path)
    ap.add_argument("dst", type=Path)
    ap.add_argument("--deflection", type=float, default=0.15)
    ap.add_argument("--angular", type=float, default=0.35)
    ap.add_argument("--y-up", action="store_true")
    a = ap.parse_args(argv)
    jobs: list[tuple[Path, Path]] = []
    if a.src.is_dir():
        for f in sorted(a.src.iterdir()):
            if f.suffix.lower() in (".step", ".stp"):
                jobs.append((f, a.dst / (f.stem.lower().replace(" ", "-") + ".glb")))
    else:
        jobs.append((a.src, a.dst))
    if not jobs:
        print("no .step/.stp files found", file=sys.stderr)
        return 1
    for src, dst in jobs:
        info = convert(src, dst, a.deflection, a.angular, a.y_up)
        size = ", ".join(f"{s * 39.3701:.2f} in" for s in info["size_m"])
        print(f"{src.name} -> {dst}  size {size}  ({info['meshes']} meshes, {len(info['materials'])} materials)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
