"""Opaque-box E2E tests for M1 (F1-F3: FM27 In-Game Icon Button)."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parents[2]
MOD_DIR = REPO_ROOT / "mod" / "FM27MoneyballButton"
ICON_PATH = MOD_DIR / "moneyball-icon.png"
CSPROJ_PATH = MOD_DIR / "FM27MoneyballButton.csproj"
PLUGIN_CS_PATH = MOD_DIR / "Plugin.cs"
BUILD_SH_PATH = MOD_DIR / "build.sh"
BUILD_DLL_PATH = MOD_DIR / "bin" / "Release" / "net6.0" / "FM27MoneyballButton.dll"

DEFAULT_BEPINEX_DIR = Path(
    os.environ.get(
        "FM27_BEPINEX_DIR",
        str(
            Path.home()
            / "Library/Application Support/Steam/steamapps/common/Football Manager 27/FM27-BepInEx/BepInEx"
        ),
    )
)
DEPLOYED_PLUGINS_DIR = DEFAULT_BEPINEX_DIR / "plugins"
DEPLOYED_DLL_PATH = DEPLOYED_PLUGINS_DIR / "FM27MoneyballButton.dll"
DEPLOYED_CFG_PATH = DEPLOYED_PLUGINS_DIR / "moneyball.config.txt"

SYSTEM_PYTHON = "/usr/bin/python3"

FSX_INSPECT_SCRIPT = r"""
#r "System.Reflection.Metadata"
open System
open System.IO
open System.Reflection
open System.Reflection.Metadata
open System.Reflection.Metadata.Ecma335
open System.Reflection.PortableExecutable
open System.Security.Cryptography
open System.Text
open System.Text.Json

let jsonEscape (s: string) = JsonSerializer.Serialize(s)

let inspectDll (dllPath: string) (includeResourceBase64: bool) =
    let bytes = File.ReadAllBytes(dllPath)
    use sha = SHA256.Create()
    let hashHex = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant()

    use ms = new MemoryStream(bytes)
    use pe = new PEReader(ms)
    let hasMeta = pe.HasMetadata

    let mutable asmRefs = ResizeArray<string>()
    let mutable memberRefs = ResizeArray<string>()
    let mutable userStrings = ResizeArray<string>()
    let mutable behaviourStaticTexFields = ResizeArray<string>()
    let mutable updateLdc40Count = 0
    let mutable updateIlLength = 0
    let mutable hasBepInPluginAttr = false
    let mutable bepInPluginGuid = ""

    if hasMeta then
        let mr = pe.GetMetadataReader()
        for h in mr.AssemblyReferences do
            let ar = mr.GetAssemblyReference(h)
            asmRefs.Add(mr.GetString(ar.Name))

        for h in mr.MemberReferences do
            let mem = mr.GetMemberReference(h)
            let name = mr.GetString(mem.Name)
            let parentName =
                match mem.Parent.Kind with
                | HandleKind.TypeReference ->
                    let tr = mr.GetTypeReference(TypeReferenceHandle.op_Explicit(mem.Parent))
                    let ns = mr.GetString(tr.Namespace)
                    let tn = mr.GetString(tr.Name)
                    if String.IsNullOrEmpty(ns) then tn else ns + "." + tn
                | HandleKind.TypeDefinition ->
                    let td = mr.GetTypeDefinition(TypeDefinitionHandle.op_Explicit(mem.Parent))
                    let ns = mr.GetString(td.Namespace)
                    let tn = mr.GetString(td.Name)
                    if String.IsNullOrEmpty(ns) then tn else ns + "." + tn
                | _ -> ""
            memberRefs.Add(parentName + "::" + name)

        let mutable usHandle = mr.GetNextHandle(MetadataTokens.UserStringHandle(0))
        while not usHandle.IsNil do
            let s = mr.GetUserString(usHandle)
            userStrings.Add(s)
            usHandle <- mr.GetNextHandle(usHandle)

        for th in mr.TypeDefinitions do
            let td = mr.GetTypeDefinition(th)
            let tname = mr.GetString(td.Name)
            if tname = "Plugin" then
                for cah in td.GetCustomAttributes() do
                    let ca = mr.GetCustomAttribute(cah)
                    let mutable ctorType = ""
                    if ca.Constructor.Kind = HandleKind.MemberReference then
                        let mem = mr.GetMemberReference(MemberReferenceHandle.op_Explicit(ca.Constructor))
                        if mem.Parent.Kind = HandleKind.TypeReference then
                            let tr = mr.GetTypeReference(TypeReferenceHandle.op_Explicit(mem.Parent))
                            ctorType <- mr.GetString(tr.Name)
                    if ctorType.Contains("BepInPlugin") then
                        hasBepInPluginAttr <- true
                        let blob = mr.GetBlobReader(ca.Value)
                        if blob.Length >= 4 then
                            let _prolog = blob.ReadUInt16()
                            let s = blob.ReadSerializedString()
                            if not (isNull s) then bepInPluginGuid <- s

            if tname = "MoneyballButtonBehaviour" then
                for fh in td.GetFields() do
                    let fd = mr.GetFieldDefinition(fh)
                    let isStatic = (fd.Attributes &&& FieldAttributes.Static) = FieldAttributes.Static
                    if isStatic then
                        behaviourStaticTexFields.Add(mr.GetString(fd.Name))

                for mh in td.GetMethods() do
                    let md = mr.GetMethodDefinition(mh)
                    let mname = mr.GetString(md.Name)
                    if mname = "Update" && md.RelativeVirtualAddress <> 0 then
                        let body = pe.GetMethodBody(md.RelativeVirtualAddress)
                        let il = body.GetILBytes()
                        updateIlLength <- il.Length
                        let mutable i = 0
                        while i <= il.Length - 5 do
                            if il.[i] = 0x22uy && il.[i+1] = 0x00uy && il.[i+2] = 0x00uy && il.[i+3] = 0x20uy && il.[i+4] = 0x42uy then
                                updateLdc40Count <- updateLdc40Count + 1
                            i <- i + 1

    let mutable resNames = ResizeArray<string>()
    let mutable iconResSha256 = ""
    let mutable iconResLen = -1
    let mutable iconResB64 = ""

    let asm = Assembly.Load(bytes)
    for rn in asm.GetManifestResourceNames() do
        resNames.Add(rn)
        if rn = "FM27MoneyballButton.moneyball-icon.png" then
            use st = asm.GetManifestResourceStream(rn)
            if not (isNull st) then
                use rms = new MemoryStream()
                st.CopyTo(rms)
                let rbytes = rms.ToArray()
                iconResLen <- rbytes.Length
                iconResSha256 <- BitConverter.ToString(sha.ComputeHash(rbytes)).Replace("-", "").ToLowerInvariant()
                if includeResourceBase64 then
                    iconResB64 <- Convert.ToBase64String(rbytes)

    let sb = StringBuilder()
    sb.Append("{") |> ignore
    sb.Append("\"sha256\":").Append(jsonEscape hashHex).Append(",") |> ignore
    sb.Append("\"has_metadata\":").Append(if hasMeta then "true" else "false").Append(",") |> ignore
    sb.Append("\"assembly_refs\":").Append(JsonSerializer.Serialize(asmRefs)).Append(",") |> ignore
    sb.Append("\"member_refs\":").Append(JsonSerializer.Serialize(memberRefs)).Append(",") |> ignore
    sb.Append("\"user_strings\":").Append(JsonSerializer.Serialize(userStrings)).Append(",") |> ignore
    sb.Append("\"resource_names\":").Append(JsonSerializer.Serialize(resNames)).Append(",") |> ignore
    sb.Append("\"icon_res_sha256\":").Append(jsonEscape iconResSha256).Append(",") |> ignore
    sb.Append("\"icon_res_len\":").Append(iconResLen).Append(",") |> ignore
    sb.Append("\"icon_res_b64\":").Append(jsonEscape iconResB64).Append(",") |> ignore
    sb.Append("\"static_fields\":").Append(JsonSerializer.Serialize(behaviourStaticTexFields)).Append(",") |> ignore
    sb.Append("\"update_il_len\":").Append(updateIlLength).Append(",") |> ignore
    sb.Append("\"update_ldc40_count\":").Append(updateLdc40Count).Append(",") |> ignore
    sb.Append("\"has_bepin_plugin_attr\":").Append(if hasBepInPluginAttr then "true" else "false").Append(",") |> ignore
    sb.Append("\"bepin_plugin_guid\":").Append(jsonEscape bepInPluginGuid) |> ignore
    sb.Append("}") |> ignore
    sb.ToString()

let args = fsi.CommandLineArgs
if args.Length < 2 then
    eprintfn "Usage: inspect.fsx <build_dll> [deployed_dll]"
    Environment.Exit(2)

let buildPath = args.[1]
let deployedPath = if args.Length >= 3 then args.[2] else ""
let bJson = if File.Exists(buildPath) then inspectDll buildPath true else "null"
let dJson =
    if not (String.IsNullOrEmpty(deployedPath)) && File.Exists(deployedPath) then
        let bytes = File.ReadAllBytes(deployedPath)
        use sha = SHA256.Create()
        let h = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant()
        "{\"exists\":true,\"sha256\":" + jsonEscape h + ",\"size\":" + string bytes.Length + "}"
    else
        "{\"exists\":false}"

printfn "{\"build\":%s,\"deployed\":%s}" bJson dJson
"""

PIL_PNG_INSPECT_SCRIPT = r"""
import base64, io, json, struct, sys
from PIL import Image

raw = sys.stdin.buffer.read()
if len(sys.argv) > 1 and sys.argv[1] == "--b64":
    raw = base64.b64decode(raw)

# Verify PNG chunk structure through IEND
png_sig = b"\x89PNG\r\n\x1a\n"
iend_clean = False
trailing_bytes = -1
if raw.startswith(png_sig):
    pos = 8
    while pos + 12 <= len(raw):
        length = struct.unpack(">I", raw[pos:pos+4])[0]
        ctype = raw[pos+4:pos+8]
        next_pos = pos + 12 + length
        if next_pos > len(raw):
            break
        pos = next_pos
        if ctype == b"IEND":
            trailing_bytes = len(raw) - pos
            iend_clean = (trailing_bytes == 0)
            break

im_v = Image.open(io.BytesIO(raw))
im_v.verify()

im = Image.open(io.BytesIO(raw))
im.load()
rgba = im.convert("RGBA") if im.mode == "RGBA" else im
pixels = list(rgba.getdata()) if im.mode == "RGBA" else []
unique_pixels = len(set(pixels))
alpha_lt_128 = sum(1 for p in pixels if p[3] < 128)
alpha_ge_200 = sum(1 for p in pixels if p[3] >= 200)
corners = []
if im.size == (64, 64) and im.mode == "RGBA":
    for xy in [(0, 0), (63, 0), (0, 63), (63, 63)]:
        corners.append(im.getpixel(xy)[3])
center_crop = im.crop((16, 16, 48, 48)) if im.size == (64, 64) and im.mode == "RGBA" else None
center_extrema = center_crop.getextrema() if center_crop is not None else None
exif_len = len(im.getexif())

print(json.dumps({
    "byte_len": len(raw),
    "has_png_sig": raw.startswith(png_sig),
    "iend_clean": iend_clean,
    "trailing_bytes": trailing_bytes,
    "size": list(im.size),
    "mode": im.mode,
    "bands": list(im.getbands()),
    "format": im.format,
    "exif_len": exif_len,
    "unique_pixels": unique_pixels,
    "alpha_lt_128": alpha_lt_128,
    "alpha_ge_200": alpha_ge_200,
    "corner_alphas": corners,
    "center_extrema": center_extrema,
}))
"""


@dataclass
class CaseResult:
    id: str
    feature: str
    tier: int
    passed: bool
    duration_ms: float
    detail: str = ""


class M1Context:
    def __init__(self) -> None:
        self._png_info: dict | None = None
        self._dll_info: dict | None = None
        self._embedded_png_info: dict | None = None
        self._csproj_tree: ET.Element | None = None
        self._config_vals: dict[str, str] | None = None

    def png_bytes(self) -> bytes:
        return ICON_PATH.read_bytes()

    def png_info(self) -> dict:
        if self._png_info is None:
            proc = subprocess.run(
                [SYSTEM_PYTHON, "-c", PIL_PNG_INSPECT_SCRIPT],
                input=self.png_bytes(),
                capture_output=True,
                timeout=15,
            )
            if proc.returncode != 0:
                raise RuntimeError(f"PIL inspect failed: {proc.stderr.decode('utf-8', 'replace')}")
            self._png_info = json.loads(proc.stdout.decode("utf-8"))
        return self._png_info

    def dll_info(self) -> dict:
        if self._dll_info is None:
            with tempfile.NamedTemporaryFile("w", suffix=".fsx", delete=False, encoding="utf-8") as tf:
                tf.write(FSX_INSPECT_SCRIPT)
                fsx_path = Path(tf.name)
            try:
                proc = subprocess.run(
                    ["dotnet", "fsi", "--quiet", str(fsx_path), str(BUILD_DLL_PATH), str(DEPLOYED_DLL_PATH)],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if proc.returncode != 0:
                    raise RuntimeError(f"dotnet fsi failed ({proc.returncode}): {proc.stderr.strip()}")
                self._dll_info = json.loads(proc.stdout.strip())
            finally:
                fsx_path.unlink(missing_ok=True)
        return self._dll_info

    def embedded_png_info(self) -> dict:
        if self._embedded_png_info is None:
            build = self.dll_info().get("build") or {}
            b64 = build.get("icon_res_b64", "")
            if not b64:
                raise RuntimeError("Embedded resource FM27MoneyballButton.moneyball-icon.png missing from DLL")
            proc = subprocess.run(
                [SYSTEM_PYTHON, "-c", PIL_PNG_INSPECT_SCRIPT, "--b64"],
                input=b64.encode("ascii"),
                capture_output=True,
                timeout=15,
            )
            if proc.returncode != 0:
                raise RuntimeError(f"Embedded PIL inspect failed: {proc.stderr.decode('utf-8', 'replace')}")
            self._embedded_png_info = json.loads(proc.stdout.decode("utf-8"))
        return self._embedded_png_info

    def csproj_root(self) -> ET.Element:
        if self._csproj_tree is None:
            self._csproj_tree = ET.parse(CSPROJ_PATH).getroot()
        return self._csproj_tree

    def moneyball_config(self) -> dict[str, str]:
        if self._config_vals is None:
            vals: dict[str, str] = {}
            raw = DEPLOYED_CFG_PATH.read_text(encoding="utf-8")
            for line in raw.splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    vals[k.strip()] = v.strip()
            self._config_vals = vals
        return self._config_vals


def _check_f1(ctx: M1Context, tier: int) -> list[tuple[str, int, Callable[[], str]]]:
    cases: list[tuple[str, int, Callable[[], str]]] = []

    if tier in (0, 1):
        def t1_01() -> str:
            assert ICON_PATH.is_file(), f"Missing {ICON_PATH}"
            sz = ICON_PATH.stat().st_size
            assert sz > 100, f"Icon too small: {sz} bytes"
            return f"{sz} bytes"

        def t1_02() -> str:
            raw = ctx.png_bytes()
            assert raw.startswith(b"\x89PNG\r\n\x1a\n"), "Missing PNG magic header"
            info = ctx.png_info()
            assert info["format"] == "PNG", f"Unexpected format: {info['format']}"
            return "Valid PNG decoded via PIL"

        def t1_03() -> str:
            info = ctx.png_info()
            assert info["size"] == [64, 64], f"Expected [64, 64], got {info['size']}"
            return "64x64"

        def t1_04() -> str:
            info = ctx.png_info()
            assert info["mode"] == "RGBA" and len(info["bands"]) == 4 and "A" in info["bands"], f"Got mode={info['mode']} bands={info['bands']}"
            return "RGBA with alpha band"

        def t1_05() -> str:
            info = ctx.png_info()
            assert info["unique_pixels"] >= 16, f"Trivial icon: only {info['unique_pixels']} unique pixels"
            return f"{info['unique_pixels']} unique RGBA pixels"

        def t1_06() -> str:
            info = ctx.png_info()
            assert info["alpha_lt_128"] > 0, "Expected transparent/semi-transparent pixels (alpha < 128)"
            assert info["alpha_ge_200"] > 256, f"Expected >256 opaque foreground pixels, got {info['alpha_ge_200']}"
            return f"transparent={info['alpha_lt_128']}, opaque={info['alpha_ge_200']}"

        cases.extend([
            ("F1-T1-01", 1, t1_01),
            ("F1-T1-02", 1, t1_02),
            ("F1-T1-03", 1, t1_03),
            ("F1-T1-04", 1, t1_04),
            ("F1-T1-05", 1, t1_05),
            ("F1-T1-06", 1, t1_06),
        ])

    if tier in (0, 2):
        def t2_01() -> str:
            info = ctx.png_info()
            assert info["iend_clean"] and info["trailing_bytes"] == 0, f"iend_clean={info['iend_clean']}, trailing={info['trailing_bytes']}"
            return "Clean IEND at EOF"

        def t2_02() -> str:
            sz = ICON_PATH.stat().st_size
            assert 256 < sz < 65536, f"Icon size {sz} outside (256, 65536)"
            return f"{sz} bytes within bounds"

        def t2_03() -> str:
            info = ctx.png_info()
            assert info["exif_len"] == 0, f"Unexpected EXIF entries: {info['exif_len']}"
            assert info["mode"] != "P", "Paletted mode P not allowed"
            return "No EXIF, direct RGBA"

        def t2_04() -> str:
            info = ctx.png_info()
            non_opaque_corners = sum(1 for a in info["corner_alphas"] if a < 255)
            assert non_opaque_corners >= 2, f"Corner alphas {info['corner_alphas']} lack transparency"
            return f"corner alphas={info['corner_alphas']}"

        def t2_05() -> str:
            info = ctx.png_info()
            ext = info["center_extrema"]
            assert ext is not None and len(ext) == 4, f"Missing center extrema: {ext}"
            rgb_span = any(ch[1] > ch[0] for ch in ext[:3])
            assert rgb_span, f"Center 32x32 crop has zero RGB variance: {ext}"
            assert ext[3][1] == 255, f"Center 32x32 crop max alpha != 255: {ext[3]}"
            return "Center 32x32 visible & opaque"

        def t2_06() -> str:
            disk_sha = hashlib.sha256(ctx.png_bytes()).hexdigest()
            build = ctx.dll_info().get("build") or {}
            res_sha = build.get("icon_res_sha256", "")
            assert res_sha == disk_sha, f"Disk SHA {disk_sha} != Embedded SHA {res_sha}"
            return f"SHA-256 parity ({disk_sha[:12]}...)"

        cases.extend([
            ("F1-T2-01", 2, t2_01),
            ("F1-T2-02", 2, t2_02),
            ("F1-T2-03", 2, t2_03),
            ("F1-T2-04", 2, t2_04),
            ("F1-T2-05", 2, t2_05),
            ("F1-T2-06", 2, t2_06),
        ])

    return cases


def _check_f2(ctx: M1Context, tier: int) -> list[tuple[str, int, Callable[[], str]]]:
    cases: list[tuple[str, int, Callable[[], str]]] = []

    if tier in (0, 1):
        def t1_01() -> str:
            root = ctx.csproj_root()
            tf = root.findtext(".//TargetFramework")
            an = root.findtext(".//AssemblyName")
            cl = root.findtext(".//CopyLocalLockFileAssemblies")
            assert tf == "net6.0", f"TargetFramework={tf}"
            assert an == "FM27MoneyballButton", f"AssemblyName={an}"
            assert cl == "false", f"CopyLocalLockFileAssemblies={cl}"
            return "Valid .csproj metadata"

        def t1_02() -> str:
            root = ctx.csproj_root()
            refs = {el.attrib.get("Include"): el for el in root.findall(".//Reference")}
            for req in ("UnityEngine.ImageConversionModule", "UnityEngine.IMGUIModule"):
                assert req in refs, f"Missing <Reference Include='{req}'>"
                el = refs[req]
                priv = el.findtext("Private")
                hint = el.findtext("HintPath") or ""
                assert priv == "false", f"{req} Private={priv}"
                assert "$(BepInExDir)/interop/" in hint, f"{req} HintPath={hint}"
            return "ImageConversionModule & IMGUIModule referenced"

        def t1_03() -> str:
            root = ctx.csproj_root()
            embeds = [el.attrib.get("Include") for el in root.findall(".//EmbeddedResource")]
            assert "moneyball-icon.png" in embeds, f"EmbeddedResource missing; found {embeds}"
            return "<EmbeddedResource Include='moneyball-icon.png' /> present"

        def t1_04() -> str:
            build = ctx.dll_info().get("build")
            assert build and build["has_metadata"], "Built DLL missing .NET metadata"
            res = build["resource_names"]
            assert "FM27MoneyballButton.moneyball-icon.png" in res, f"Manifest resources={res}"
            return "Valid PE metadata & embedded resource"

        def t1_05() -> str:
            build = ctx.dll_info().get("build")
            assert build, "Built DLL missing"
            refs = set(build["assembly_refs"])
            expected = {
                "UnityEngine.ImageConversionModule",
                "UnityEngine.IMGUIModule",
                "UnityEngine.UIElementsModule",
                "UnityEngine.CoreModule",
                "BepInEx.Core",
                "BepInEx.Unity.IL2CPP",
                "Il2CppInterop.Runtime",
            }
            missing = expected - refs
            assert not missing, f"Missing DLL assembly refs: {sorted(missing)}"
            return f"All {len(expected)} assembly refs present"

        def t1_06() -> str:
            info = ctx.embedded_png_info()
            assert info["size"] == [64, 64] and info["mode"] == "RGBA" and info["format"] == "PNG", f"Embedded resource decoded as {info}"
            return "Embedded resource decodes to 64x64 RGBA PNG"

        cases.extend([
            ("F2-T1-01", 1, t1_01),
            ("F2-T1-02", 1, t1_02),
            ("F2-T1-03", 1, t1_03),
            ("F2-T1-04", 1, t1_04),
            ("F2-T1-05", 1, t1_05),
            ("F2-T1-06", 1, t1_06),
        ])

    if tier in (0, 2):
        def t2_01() -> str:
            out_dir = BUILD_DLL_PATH.parent
            assert out_dir.is_dir(), f"Missing {out_dir}"
            leaked = [
                p.name
                for p in out_dir.glob("*.dll")
                if p.name.startswith(("UnityEngine.", "BepInEx.", "Il2Cpp"))
            ]
            assert not leaked, f"Leaked Private=true DLLs in output dir: {leaked}"
            return "Zero leaked Unity/BepInEx/Il2Cpp DLLs"

        def t2_02() -> str:
            build = ctx.dll_info().get("build")
            assert build, "Built DLL missing"
            png_res = [r for r in build["resource_names"] if r.endswith(".png")]
            assert png_res == ["FM27MoneyballButton.moneyball-icon.png"], f"Unexpected PNG resources: {png_res}"
            return "Exactly 1 PNG manifest resource"

        def t2_03() -> str:
            proc = subprocess.run(
                [
                    "dotnet",
                    "msbuild",
                    str(CSPROJ_PATH),
                    "-getProperty:BepInExDir",
                    "-p:FM27_BEPINEX_DIR=/tmp/fake_bepinex",
                ],
                capture_output=True,
                text=True,
                timeout=20,
            )
            assert proc.returncode == 0, f"dotnet msbuild failed: {proc.stderr.strip()}"
            val = proc.stdout.strip()
            assert val == "/tmp/fake_bepinex", f"Expected '/tmp/fake_bepinex', got '{val}'"
            return "FM27_BEPINEX_DIR MSBuild override resolved"

        def t2_04() -> str:
            root = ctx.csproj_root()
            missing = []
            for el in root.findall(".//Reference"):
                hint = el.findtext("HintPath") or ""
                resolved = Path(hint.replace("$(BepInExDir)", str(DEFAULT_BEPINEX_DIR)))
                if not resolved.is_file():
                    missing.append(str(resolved))
            assert not missing, f"Missing HintPath targets: {missing}"
            return "All HintPath DLLs exist under BepInExDir"

        def t2_05() -> str:
            env = {**os.environ, "FM27_BEPINEX_DIR": "/nonexistent"}
            proc = subprocess.run(
                [str(BUILD_SH_PATH)],
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )
            combined = proc.stdout + proc.stderr
            assert proc.returncode != 0, "Expected non-zero exit when FM27_BEPINEX_DIR=/nonexistent"
            assert "Missing /nonexistent/interop" in combined, f"Expected missing interop msg, got: {combined!r}"
            return "build.sh missing-interop guard exited non-zero"

        def t2_06() -> str:
            with tempfile.TemporaryDirectory(prefix="e2e_m1_build_") as tmpdir:
                tmp_root = Path(tmpdir)
                src_dir = tmp_root / "src"
                out_dir = tmp_root / "out"
                src_dir.mkdir(parents=True, exist_ok=True)
                for fn in ("FM27MoneyballButton.csproj", "Plugin.cs", "moneyball-icon.png"):
                    shutil.copy2(MOD_DIR / fn, src_dir / fn)
                env = {**os.environ, "FM27_BEPINEX_DIR": str(DEFAULT_BEPINEX_DIR)}
                proc = subprocess.run(
                    [
                        "dotnet",
                        "build",
                        str(src_dir / "FM27MoneyballButton.csproj"),
                        "-c",
                        "Release",
                        "-o",
                        str(out_dir),
                        f"-p:BaseIntermediateOutputPath={tmp_root}/obj/",
                    ],
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=45,
                )
                assert proc.returncode == 0, f"Isolated dotnet build failed: {proc.stdout}\n{proc.stderr}"
                assert (out_dir / "FM27MoneyballButton.dll").is_file(), "Output DLL missing in tmpdir"
            return "Isolated Release build succeeded"

        cases.extend([
            ("F2-T2-01", 2, t2_01),
            ("F2-T2-02", 2, t2_02),
            ("F2-T2-03", 2, t2_03),
            ("F2-T2-04", 2, t2_04),
            ("F2-T2-05", 2, t2_05),
            ("F2-T2-06", 2, t2_06),
        ])

    return cases


def _check_f3(ctx: M1Context, tier: int) -> list[tuple[str, int, Callable[[], str]]]:
    cases: list[tuple[str, int, Callable[[], str]]] = []

    if tier in (0, 1):
        def t1_01() -> str:
            build = ctx.dll_info().get("build") or {}
            mrefs = set(build.get("member_refs", []))
            ustrs = set(build.get("user_strings", []))
            assert "UnityEngine.ImageConversion::LoadImage" in mrefs, "Missing ImageConversion::LoadImage ref"
            assert "UnityEngine.Texture2D::.ctor" in mrefs, "Missing Texture2D::.ctor ref"
            assert "FM27MoneyballButton.moneyball-icon.png" in ustrs, "Missing icon resource user string"
            return "IL loads embedded PNG via ImageConversion.LoadImage"

        def t1_02() -> str:
            build = ctx.dll_info().get("build") or {}
            mrefs = set(build.get("member_refs", []))
            for req in (
                "UnityEngine.UIElements.Button::.ctor",
                "UnityEngine.UIElements.Image::.ctor",
                "UnityEngine.UIElements.Image::set_image",
                "UnityEngine.UIElements.VisualElement::Add",
            ):
                assert req in mrefs, f"Missing MemberRef {req}"
            return "IL embeds UIElements.Image inside Button"

        def t1_03() -> str:
            build = ctx.dll_info().get("build") or {}
            mrefs = set(build.get("member_refs", []))
            ustrs = set(build.get("user_strings", []))
            assert "UnityEngine.UIElements.VisualElement::set_tooltip" in mrefs, "Missing set_tooltip ref"
            assert "UnityEngine.UIElements.TextElement::set_text" not in mrefs, "Unexpected TextElement::set_text"
            assert "UnityEngine.UIElements.Button::set_text" not in mrefs, "Unexpected Button::set_text"
            assert "Moneyball Scout" in ustrs, "Missing 'Moneyball Scout' tooltip string"
            assert "moneyball-launch-btn" in ustrs, "Missing 'moneyball-launch-btn' string"
            assert "Moneyball" not in ustrs, "Standalone 'Moneyball' label string still present"
            return "Tooltip='Moneyball Scout', no standalone 'Moneyball' text"

        def t1_04() -> str:
            build = ctx.dll_info().get("build") or {}
            mrefs = set(build.get("member_refs", []))
            for req in (
                "UnityEngine.UIElements.IStyle::set_width",
                "UnityEngine.UIElements.IStyle::set_height",
                "UnityEngine.UIElements.VisualElement::set_pickingMode",
            ):
                assert req in mrefs, f"Missing MemberRef {req}"
            cnt = build.get("update_ldc40_count", 0)
            assert cnt >= 2, f"Expected >=2 ldc.r4 40.0f in Update() IL, got {cnt}"
            src = PLUGIN_CS_PATH.read_text(encoding="utf-8")
            assert "PickingMode.Ignore" in src and "PickingMode.Position" in src, "Missing PickingMode contract in Plugin.cs"
            return f"40x40 sizing (ldc.r4 40f x{cnt}) & PickingMode verified"

        def t1_05() -> str:
            info = ctx.dll_info()
            build = info.get("build") or {}
            dep = info.get("deployed") or {}
            assert dep.get("exists"), f"Deployed DLL missing at {DEPLOYED_DLL_PATH}"
            assert build.get("sha256") == dep.get("sha256"), f"Build SHA {build.get('sha256')} != Deployed SHA {dep.get('sha256')}"
            return f"Deployed DLL SHA parity ({dep['sha256'][:12]}...)"

        def t1_06() -> str:
            assert DEPLOYED_CFG_PATH.is_file(), f"Missing {DEPLOYED_CFG_PATH}"
            cfg = ctx.moneyball_config()
            py_path = Path(cfg.get("python", ""))
            srv_path = Path(cfg.get("server", ""))
            assert py_path.is_file() and os.access(py_path, os.X_OK), f"Invalid python binary in config: {py_path}"
            assert srv_path.is_file() and srv_path.name == "server.py", f"Invalid server script in config: {srv_path}"
            return "moneyball.config.txt valid"

        cases.extend([
            ("F3-T1-01", 1, t1_01),
            ("F3-T1-02", 1, t1_02),
            ("F3-T1-03", 1, t1_03),
            ("F3-T1-04", 1, t1_04),
            ("F3-T1-05", 1, t1_05),
            ("F3-T1-06", 1, t1_06),
        ])

    if tier in (0, 2):
        def t2_01() -> str:
            build = ctx.dll_info().get("build") or {}
            static_fields = build.get("static_fields", [])
            assert "_cachedIconTexture" in static_fields or len(static_fields) >= 1, f"Missing static cache field on MoneyballButtonBehaviour: {static_fields}"
            return f"Static texture cache fields: {static_fields}"

        def t2_02() -> str:
            build = ctx.dll_info().get("build") or {}
            mrefs = set(build.get("member_refs", []))
            ustrs = build.get("user_strings", [])
            assert "System.Reflection.Assembly::GetManifestResourceStream" in mrefs, "Missing GetManifestResourceStream"
            assert "BepInEx.Logging.ManualLogSource::LogWarning" in mrefs, "Missing LogWarning guard"
            assert any("not found" in s.lower() for s in ustrs), "Missing resource-not-found warning string"
            assert any("loadimage" in s.lower() or "failed" in s.lower() for s in ustrs), "Missing LoadImage failure warning string"
            return "Null stream & LoadImage failure guards present"

        def t2_03() -> str:
            assert DEPLOYED_PLUGINS_DIR.is_dir(), f"Missing {DEPLOYED_PLUGINS_DIR}"
            dlls = [p.name for p in DEPLOYED_PLUGINS_DIR.glob("*.dll")]
            unintended = [d for d in dlls if d != "FM27MoneyballButton.dll"]
            assert not unintended, f"Unexpected DLLs in $BEPINEX/plugins/: {unintended}"
            return f"Clean $BEPINEX/plugins/ ({dlls})"

        def t2_04() -> str:
            raw_bytes = DEPLOYED_CFG_PATH.read_bytes()
            assert b"\r" not in raw_bytes, "CRLF detected in moneyball.config.txt"
            cfg = ctx.moneyball_config()
            for key in ("python", "server"):
                val = cfg.get(key, "")
                assert val and not val.startswith(('"', "'")) and not val.endswith(('"', "'")), f"Bad {key} value: {val!r}"
                assert Path(val).is_absolute() and Path(val).exists(), f"Missing/relative {key}: {val!r}"
            return "moneyball.config.txt hygiene OK"

        def t2_05() -> str:
            py_bin = ctx.moneyball_config().get("python", "")
            proc = subprocess.run([py_bin, "-c", "import fmsave"], capture_output=True, text=True, timeout=15)
            assert proc.returncode == 0, f"'{py_bin} -c import fmsave' failed: {proc.stderr.strip()}"
            return "Configured python imports fmsave"

        def t2_06() -> str:
            build = ctx.dll_info().get("build") or {}
            ustrs = set(build.get("user_strings", []))
            assert build.get("has_bepin_plugin_attr"), "Missing [BepInPlugin] attribute"
            assert build.get("bepin_plugin_guid") == "com.fm27.moneyball.button", f"GUID={build.get('bepin_plugin_guid')!r}"
            assert any("http://127.0.0.1:8727/?auto_refresh=1" in s for s in ustrs), "Dashboard URL string missing"
            return "BepInPlugin GUID & dashboard URL preserved"

        cases.extend([
            ("F3-T2-01", 2, t2_01),
            ("F3-T2-02", 2, t2_02),
            ("F3-T2-03", 2, t2_03),
            ("F3-T2-04", 2, t2_04),
            ("F3-T2-05", 2, t2_05),
            ("F3-T2-06", 2, t2_06),
        ])

    return cases


def run_m1_tests(tier: int = 0) -> list[CaseResult]:
    ctx = M1Context()
    specs: list[tuple[str, str, int, Callable[[], str]]] = []
    for cid, ctier, fn in _check_f1(ctx, tier):
        specs.append((cid, "F1", ctier, fn))
    for cid, ctier, fn in _check_f2(ctx, tier):
        specs.append((cid, "F2", ctier, fn))
    for cid, ctier, fn in _check_f3(ctx, tier):
        specs.append((cid, "F3", ctier, fn))

    results: list[CaseResult] = []
    for cid, feat, ctier, fn in specs:
        t0 = time.perf_counter()
        try:
            detail = fn()
            dt = (time.perf_counter() - t0) * 1000.0
            results.append(CaseResult(cid, feat, ctier, True, dt, detail))
        except Exception as exc:
            dt = (time.perf_counter() - t0) * 1000.0
            results.append(CaseResult(cid, feat, ctier, False, dt, str(exc)))
    return results


if __name__ == "__main__":
    req_tier = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    res = run_m1_tests(req_tier)
    fails = 0
    for r in res:
        tag = "[PASS]" if r.passed else "[FAIL]"
        if not r.passed:
            fails += 1
        print(f"{tag} {r.id} ({r.duration_ms:.1f}ms) - {r.detail}")
    sys.exit(1 if fails else 0)
