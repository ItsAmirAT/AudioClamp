import os
import sys
import subprocess

project_dir = os.path.dirname(os.path.abspath(__file__))
web_dir = os.path.join(project_dir, "ui", "web")
assets_dir = os.path.join(project_dir, "assets")
icon_ico = os.path.join(assets_dir, "icon_active.ico")
manifest_path = os.path.join(project_dir, "app.manifest")

print(f"Building AudioClamp standalone executable from {project_dir}...")

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
if res.returncode == 0:
    exe_path = os.path.join(project_dir, "dist", "AudioClamp.exe")
    print("\n" + "=" * 50)
    print("Build successful!")
    print(f"Executable: {exe_path}")
    print(f"Size: {os.path.getsize(exe_path) / (1024 * 1024):.2f} MB")
    print("=" * 50)
else:
    print(f"Build failed with exit code: {res.returncode}")
