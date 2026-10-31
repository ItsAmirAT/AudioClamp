import os
import sys
import shutil
import subprocess

project_dir = os.path.dirname(os.path.abspath(__file__))
web_dir = os.path.join(project_dir, "ui", "web")
assets_dir = os.path.join(project_dir, "assets")
icon_ico = os.path.join(assets_dir, "icon_active.ico")
manifest_path = os.path.join(project_dir, "app.manifest")
installer_script = os.path.join(project_dir, "installer", "AudioClamp.iss")

sys.path.insert(0, project_dir)
from core import __version__ as app_version

# Installer versions use three parts (2.5 -> 2.5.0) to match the release tags
installer_version = app_version if app_version.count(".") >= 2 else f"{app_version}.0"


def find_iscc():
    found = shutil.which("ISCC")
    if found:
        return found
    candidates = [
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Inno Setup 6", "ISCC.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Inno Setup 6", "ISCC.exe"),
        os.path.join(os.environ.get("ProgramFiles", ""), "Inno Setup 6", "ISCC.exe"),
    ]
    return next((c for c in candidates if os.path.isfile(c)), None)


def build_onedir():
    """One-folder build for the installer: starts faster than the self-extracting single file."""
    print("\nBuilding one-folder version for the installer...")
    onedir_cmd = [c for c in cmd if c != "--onefile"] + [
        f"--distpath={os.path.join(project_dir, 'dist', 'onedir')}",
        f"--workpath={os.path.join(project_dir, 'build', 'onedir')}",
    ]
    res = subprocess.run(onedir_cmd, cwd=project_dir)
    if res.returncode != 0:
        print(f"One-folder build failed with exit code: {res.returncode}")
        return None
    return os.path.join(project_dir, "dist", "onedir", "AudioClamp")


def build_installer(source_dir):
    iscc = find_iscc()
    if not iscc:
        print("Inno Setup 6 not found. Install it with: winget install --id JRSoftware.InnoSetup -e --scope user")
        return 1
    print(f"\nBuilding installer for AudioClamp {installer_version}...")
    res = subprocess.run([iscc, f"/DAppVersion={installer_version}", f"/DSourceDir={source_dir}", installer_script], cwd=project_dir)
    if res.returncode == 0:
        setup_path = os.path.join(project_dir, "dist", "installer", f"AudioClamp-Setup-{installer_version}.exe")
        print(f"Installer: {setup_path} ({os.path.getsize(setup_path) / (1024 * 1024):.2f} MB)")
    else:
        print(f"Installer build failed with exit code: {res.returncode}")
    return res.returncode


print(f"Building AudioClamp {app_version} standalone executable from {project_dir}...")

cmd = [
    sys.executable, "-m", "PyInstaller",
    "--noconsole",
    "--onefile",
    f"--icon={icon_ico}",
    f"--manifest={manifest_path}",
    f"--add-data={web_dir};ui/web",
    f"--add-data={assets_dir};assets",
    "--hidden-import=webview",
    "--hidden-import=clr_loader",
    "--hidden-import=pythonnet",
    "--hidden-import=bottle",
    "--name=AudioClamp",
    "--clean",
    os.path.join(project_dir, "main.py")
]

res = subprocess.run(cmd, cwd=project_dir)
if res.returncode != 0:
    print(f"Build failed with exit code: {res.returncode}")
    sys.exit(res.returncode)

exe_path = os.path.join(project_dir, "dist", "AudioClamp.exe")
print("\n" + "=" * 50)
print("Build successful!")
print(f"Executable: {exe_path}")
print(f"Size: {os.path.getsize(exe_path) / (1024 * 1024):.2f} MB")
print("=" * 50)

if "--installer" in sys.argv:
    source_dir = build_onedir()
    if source_dir is None:
        sys.exit(1)
    sys.exit(build_installer(source_dir))
