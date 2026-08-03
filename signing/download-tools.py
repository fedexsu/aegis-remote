"""Fetch signtool.exe (Windows SDK BuildTools) and the Azure Trusted Signing
dlib from nuget.org, extracting them into signing/tools/. No dotnet/nuget needed."""
import io, json, os, shutil, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.join(HERE, 'tools')
os.makedirs(TOOLS, exist_ok=True)


def latest_stable(pkg):
    url = f"https://api.nuget.org/v3-flatcontainer/{pkg}/index.json"
    vers = json.load(urllib.request.urlopen(url))['versions']
    stable = [v for v in vers if '-' not in v]
    return (stable or vers)[-1]


def open_nupkg(pkg, ver):
    url = f"https://api.nuget.org/v3-flatcontainer/{pkg}/{ver}/{pkg}.{ver}.nupkg"
    print(f"  downloading {pkg} {ver}")
    return zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(url).read()))


def extract_dir(z, base, dest):
    os.makedirs(dest, exist_ok=True)
    for n in z.namelist():
        if n.startswith(base + '/') and not n.endswith('/'):
            target = os.path.join(dest, os.path.relpath(n, base))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(n) as src, open(target, 'wb') as dst:
                shutil.copyfileobj(src, dst)


print("== signtool (Microsoft.Windows.SDK.BuildTools) ==")
pkg = 'microsoft.windows.sdk.buildtools'
z = open_nupkg(pkg, latest_stable(pkg))
st = [n for n in z.namelist() if n.lower().endswith('/x64/signtool.exe')]
if not st:
    raise SystemExit("signtool.exe not found in package")
base = st[0].rsplit('/', 1)[0]
extract_dir(z, base, os.path.join(TOOLS, 'signtool'))
print(f"  -> tools/signtool/signtool.exe")

print("== Trusted Signing dlib (Microsoft.Trusted.Signing.Client) ==")
pkg = 'microsoft.trusted.signing.client'
z = open_nupkg(pkg, latest_stable(pkg))
dl = [n for n in z.namelist() if n.lower().endswith('/x64/azure.codesigning.dlib.dll')]
if not dl:
    dl = [n for n in z.namelist() if n.lower().endswith('.dlib.dll') and 'x64' in n.lower()]
if not dl:
    raise SystemExit("dlib not found in package")
base = dl[0].rsplit('/', 1)[0]
extract_dir(z, base, os.path.join(TOOLS, 'dlib'))
print(f"  -> tools/dlib/ ({os.path.basename(dl[0])})")

print("\nDone. Tools in signing/tools/")
